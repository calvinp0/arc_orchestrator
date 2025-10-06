import { useEffect, useState } from "react";
import { loadConfig, saveConfig, defaults, AppConfigSchema, type AppConfig, type RemoteProfile } from "../lib/store";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { setRemotePassword as setRemotePwGlobal } from "../lib/remoteSecrets";

type SettingsProps = {
  onSwitchToRuns?: () => void;
};

export default function Settings({ onSwitchToRuns }: SettingsProps) {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState("");
  const [settingsPath, setSettingsPath] = useState<string>("");
  const [err, setErr] = useState<string>("");

  // local-only secret; not persisted; clear every time you open Settings
  const [remotePassword, setRemotePwLocal] = useState("");
  const [showPw, setShowPw] = useState(false);

  const up = (patch: Partial<AppConfig>) => setCfg((c) => ({ ...(c ?? defaults), ...patch }));
  const upRemote = (patch: Partial<RemoteProfile>) =>
    setCfg((c) => ({
      ...(c ?? defaults),
      remote: {
        host: "", port: 22, user: "", auth: "agent", use_agent: true,
        key_path: "", key_pass: "", ...(c?.remote ?? {}),
        ...patch,
      } as RemoteProfile,
    }));

  useEffect(() => {
    (async () => {
      try {
        const dir = await appDataDir();
        setSettingsPath(await join(dir, ".settings.json"));
      } catch (e: any) {
        setErr("Could not resolve app data dir: " + String(e?.message ?? e));
      }
      try {
        const loaded = await loadConfig();
        const withDefaults: AppConfig = {
          ...defaults, ...loaded,
          remote: {
            host: "", port: 22, user: "",
            auth: loaded.remote?.auth ?? (loaded.remote?.use_agent ? "agent" : "key"),
            use_agent: loaded.remote?.use_agent ?? true,
            key_path: loaded.remote?.key_path ?? "",
            key_pass: loaded.remote?.key_pass ?? "",
            ...(loaded.remote ?? {}),
          } as RemoteProfile,
        };
        setCfg(withDefaults);
      } catch (e: any) {
        setErr("Could not load settings: " + String(e?.message ?? e));
        setCfg({ ...defaults });
      }
      // clear the password field whenever this page mounts
      setRemotePwLocal("");
    })();
  }, []);

  if (!cfg) return <div>Loading…</div>;

  async function onSave() {
    if (!cfg) return;
    try {
      const cap = Math.min(64, Math.max(1, Number(cfg.concurrency_cap || 1)));
      await saveConfig({ ...cfg, concurrency_cap: cap }); // no password persisted
      setStatus("Saved ✓");
      setTimeout(() => setStatus(""), 1200);
    } catch (e: any) {
      setErr("Save failed: " + String(e?.message ?? e));
    }
  }

  async function onSaveAs() {
    if (!cfg) return;
    try {
      const target = await saveDialog({
        defaultPath: settingsPath || "settings.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!target) return;
      const cap = Math.min(64, Math.max(1, Number(cfg.concurrency_cap || 1)));
      const validated = AppConfigSchema.parse({ ...cfg, concurrency_cap: cap });
      await writeTextFile(target as string, JSON.stringify(validated, null, 2));
      setStatus("Exported ✓");
      setTimeout(() => setStatus(""), 1200);
    } catch (e: any) {
      setErr("Save As failed: " + String(e?.message ?? e));
    }
  }

  async function onOpenFromFile() {
    try {
      const picked = await openDialog({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!picked) return;
      const text = await readTextFile(picked as string);
      const raw = JSON.parse(text);
      const parsed = AppConfigSchema.partial().safeParse(raw);
      const merged: AppConfig = { ...defaults, ...(parsed.success ? parsed.data : {}) };
      setCfg(merged);
      await saveConfig(merged);
      setStatus("Imported & applied ✓");
      setTimeout(() => setStatus(""), 1600);
    } catch (e: any) {
      setErr("Open failed: " + String(e?.message ?? e));
    }
  }

  async function testRemote() {
    if (!cfg?.remote) return;
    const profile = {
      ...cfg.remote,
      password: (cfg.remote.auth === "password") ? remotePassword : undefined,
    };
    try {
      const res = await invoke<string>("remote_ping", { profile });
      setStatus(`Remote OK: ${res}`);
      setTimeout(() => setStatus(""), 1500);
      // cache to memory for Runs page
      if (cfg.remote.auth === "password") setRemotePwGlobal(remotePassword);
    } catch (e: any) {
      setErr("Remote test failed: " + String(e?.message ?? e));
    }
  }

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 760 }}>
      <h2>Settings</h2>
      {onSwitchToRuns && (
        <button onClick={onSwitchToRuns} style={{ justifySelf: "start" }}>
          ← Back to Runs
        </button>
      )}
      {err && <div style={{ color: "#ff6b6b" }}>{err}</div>}

      {/* Python */}
      <label style={{ display: "grid", gap: 6 }}>
        <span>Python path</span>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ flex: 1 }} value={cfg.python_path}
                 onChange={(e) => up({ python_path: e.target.value })}
                 placeholder="/home/calvin/miniforge3/envs/arc_env/bin/python" />
          <button onClick={async () => {
            const p = await openDialog({ multiple: false }); if (p) up({ python_path: p as string });
          }}>Browse…</button>
        </div>
      </label>

      {/* ARC.py */}
      <label style={{ display: "grid", gap: 6 }}>
        <span>ARC.py path</span>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ flex: 1 }} value={cfg.arc_path}
                 onChange={(e) => up({ arc_path: e.target.value })}
                 placeholder="/home/calvin/Code/ARC/ARC.py" />
          <button onClick={async () => {
            const p = await openDialog({ multiple: false }); if (p) up({ arc_path: p as string });
          }}>Browse…</button>
        </div>
      </label>

      {/* Work dir */}
      <label style={{ display: "grid", gap: 6 }}>
        <span>Cluster work dir</span>
        <input value={cfg.default_work_dir}
               onChange={(e) => up({ default_work_dir: e.target.value })}
               placeholder="/home/calvin.p/runs/ARC/PhD/RMG" />
      </label>

      {/* Concurrency */}
      <label style={{ display: "grid", gap: 6 }}>
        <span>Concurrency cap</span>
        <input type="number" min={1} max={64}
               value={cfg.concurrency_cap}
               onChange={(e) => up({ concurrency_cap: Number(e.target.value) || 1 })} />
      </label>

      {/* tmux path */}
      <label style={{ display: "grid", gap: 6 }}>
        <span>tmux path (optional)</span>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ flex: 1 }} value={cfg.tmux_path ?? ""}
                 onChange={(e) => up({ tmux_path: e.target.value })}
                 placeholder="Leave blank to use tmux from PATH" />
          <button onClick={async () => {
            const p = await openDialog({ multiple: false }); if (p) up({ tmux_path: p as string });
          }}>Browse…</button>
        </div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          Don’t have tmux?{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); openUrl("https://github.com/tmux/tmux/wiki/Installing"); }}>
            Installation guide
          </a>
        </div>
      </label>

      {/* File ops */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", paddingTop: 6 }}>
        <button onClick={onSave}>Save</button>
        <button onClick={onSaveAs}>Save As…</button>
        <button onClick={onOpenFromFile}>Open…</button>
        <span style={{ opacity: 0.8 }}>{status}</span>
        {settingsPath && <code style={{ opacity: 0.7, fontSize: 12 }}>{settingsPath}</code>}
      </div>

      {/* Remote (SSH) */}
      <section style={{ display: "grid", gap: 12, paddingTop: 12 }}>
        <h3>Remote server (SSH)</h3>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Host</span>
          <input placeholder="hpc.example.edu"
                 value={cfg.remote?.host ?? ""}
                 onChange={(e) => upRemote({ host: e.target.value })} />
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span>Port</span>
            <input type="number" min={1} max={65535}
                   value={cfg.remote?.port ?? 22}
                   onChange={(e) => upRemote({ port: Number(e.target.value) || 22 })} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <span>User</span>
            <input placeholder="calvin"
                   value={cfg.remote?.user ?? ""}
                   onChange={(e) => upRemote({ user: e.target.value })} />
          </label>
        </div>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <label><input type="radio" name="rauth"
                        checked={(cfg.remote?.auth ?? "agent") === "agent"}
                        onChange={() => upRemote({ auth: "agent", use_agent: true })} /> SSH agent</label>
          <label><input type="radio" name="rauth"
                        checked={cfg.remote?.auth === "key"}
                        onChange={() => upRemote({ auth: "key", use_agent: false })} /> Key file</label>
          <label><input type="radio" name="rauth"
                        checked={cfg.remote?.auth === "password"}
                        onChange={() => upRemote({ auth: "password", use_agent: false })} /> Password</label>
        </div>

        {cfg.remote?.auth === "key" && (
          <div style={{ display: "grid", gap: 12 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span>Private key path</span>
              <div style={{ display: "flex", gap: 8 }}>
                <input style={{ flex: 1 }} placeholder="~/.ssh/id_ed25519"
                       value={cfg.remote?.key_path ?? ""}
                       onChange={(e) => upRemote({ key_path: e.target.value })} />
                <button onClick={async () => {
                  const p = await openDialog({ multiple: false });
                  if (p) upRemote({ key_path: p as string });
                }}>Browse…</button>
              </div>
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span>Key passphrase (optional)</span>
              <input type="password"
                     value={cfg.remote?.key_pass ?? ""}
                     onChange={(e) => upRemote({ key_pass: e.target.value })} />
            </label>
          </div>
        )}

        {cfg.remote?.auth === "password" && (
          <label style={{ display: "grid", gap: 6 }}>
            <span>Password</span>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type={showPw ? "text" : "password"}
                value={remotePassword}
                onChange={(e) => {
                  const pw = e.target.value;
                  setRemotePwLocal(pw);       // local input
                  setRemotePwGlobal(pw);      // memory cache for Runs
                }}
                autoComplete="new-password"
              />
              <button type="button" onClick={() => setShowPw(s => !s)}>
                {showPw ? "Hide" : "Show"}
              </button>
            </div>
            <small style={{ opacity: 0.7 }}>
              Password is kept in memory only (cleared on app exit).
            </small>
          </label>
        )}

        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button onClick={testRemote}>Test remote</button>
          <span style={{ opacity: 0.8 }}>{status}</span>
        </div>
      </section>
    </div>
  );
}
