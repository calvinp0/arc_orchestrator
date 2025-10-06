import { Store } from "@tauri-apps/plugin-store";
import { z } from "zod";

export const RemoteAuthSchema = z.enum(["agent", "key", "password"]);

export const RemoteProfileSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().min(1, "User is required"),
  auth: RemoteAuthSchema.default("agent"),
  key_path: z.string().optional().default(""),
  key_pass: z.string().optional(),
  use_agent: z.boolean().default(true), // legacy; still accepted
});
export type RemoteProfile = z.infer<typeof RemoteProfileSchema>;

export const AppConfigSchema = z.object({
  python_path: z.string().min(1),
  arc_path: z.string().min(1),
  default_work_dir: z.string().default(""),
  concurrency_cap: z.number().int().min(1).max(64),
  tmux_path: z.string().optional().default(""),
  remote: RemoteProfileSchema.optional(),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export const defaults: AppConfig = {
  python_path: "python",
  arc_path: "arc",
  default_work_dir: "",
  concurrency_cap: 2,
  tmux_path: "",
  remote: undefined,
};

let storePromise: Promise<Store> | null = null;
async function getStore(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(".settings.json");
  return storePromise;
}

async function withTimeout<T>(p: Promise<T>, ms = 2000): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const store = await withTimeout(getStore());
    const raw = await withTimeout(store.get("config"));
    const parsed = AppConfigSchema.partial().safeParse(raw);
    return { ...defaults, ...(parsed.success ? parsed.data : {}) };
  } catch {
    return { ...defaults };
  }
}

export async function safeLoadConfig(): Promise<AppConfig> {
  return loadConfig();
}

export async function saveConfig(cfg: AppConfig) {
  const ok = AppConfigSchema.safeParse(cfg);
  if (!ok.success) throw new Error(ok.error.message);
  const store = await getStore();
  await store.set("config", ok.data);
  await store.save();
}
