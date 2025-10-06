import { invoke } from "@tauri-apps/api/core";

export type TmuxProbe = {
  found: boolean;
  path?: string;
  version?: string;
  stderr?: string;
  code?: number;
};

export async function probeTmuxBackend(): Promise<TmuxProbe> {
  return await invoke<TmuxProbe>("probe_tmux");
}
