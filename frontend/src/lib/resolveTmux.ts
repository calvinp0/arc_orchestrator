// src/lib/resolveTmux.ts
import { Command } from "@tauri-apps/plugin-shell";
import { safeLoadConfig, saveConfig } from "./store";
import type { AppConfig } from "./typeguard";

const DEBUG = true;
const CANDIDATES = ["tmux", "/usr/bin/tmux", "/bin/tmux"];

async function execWithTimeout(cmd: string, args: string[], ms = 2000) {
  const t0 = performance.now();
  if (DEBUG) console.debug("[tmux] exec start:", cmd, args);
  const command = Command.create(cmd, args);
  const p = command.execute();
  const t = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
  try {
    const out = (await Promise.race([p, t])) as { code: number; stdout: string; stderr: string };
    if (DEBUG) console.debug("[tmux] exec done:", cmd, { dt: (performance.now() - t0).toFixed(1), ...out });
    return out;
  } catch (e) {
    if (DEBUG) console.debug("[tmux] exec threw:", cmd, e);
    throw e;
  }
}

async function canRun(cmd: string): Promise<boolean> {
  try {
    if (DEBUG) console.debug("[tmux] checking candidate:", cmd);
    const out = await execWithTimeout(cmd, ["-V"], 2000);
    if (out.code !== 0) {
      if (DEBUG) console.debug("[tmux] non-zero exit for -V", { cmd, code: out.code, stderr: out.stderr, stdout: out.stdout });
      return false;
    }
    return true;
  } catch (e) {
    if (DEBUG) console.debug("[tmux] check failed for", cmd, e);
    return false;
  }
}

export async function resolveTmuxPath(): Promise<string | null> {
  const cfg = await safeLoadConfig();
  if (DEBUG) console.debug("[tmux] stored tmux_path =", cfg.tmux_path || "(none)");

  if (cfg.tmux_path?.trim() && (await canRun(cfg.tmux_path))) {
    if (DEBUG) console.debug("[tmux] using stored path:", cfg.tmux_path);
    return cfg.tmux_path;
  }

  for (const cand of CANDIDATES) {
    if (await canRun(cand)) {
      const next: AppConfig = { ...cfg, tmux_path: cand };
      await saveConfig(next);
      if (DEBUG) console.debug("[tmux] resolved & saved path:", cand);
      return cand;
    }
  }

  if (DEBUG) console.debug("[tmux] no candidates worked");
  return null;
}
