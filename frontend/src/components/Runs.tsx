import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { getRemotePassword, onRemotePasswordChange } from "../lib/remoteSecrets";
import { safeLoadConfig } from "../lib/store";
import {
  buildWindowCacheKey,
  clearWindowCacheForSession,
  pruneWindowCache,
  renameSessionInCache,
} from "../lib/windowCache";

type Session = { name: string; windows: number; attached: boolean };
export type TmuxWindow = { index: number; id: string; name: string; active: boolean; panes: number };
export type HostProfile = {
  host: string;
  port?: number;
  user: string;
  auth?: "agent" | "key" | "password";
  key_path?: string;
  key_pass?: string;
  use_agent?: boolean;
  password?: string;  // injected at runtime when auth=password
};

export type Mode =
  | { kind: "local" }
  | { kind: "remote"; profile: HostProfile };

type ControlEventPayload = {
  key: string;
  kind: string;
  line?: string | null;
};

type ControlPending = {
  command: string;
  resolve: (chunks: string[]) => void;
  reject: (err: Error) => void;
  data: string[];
};

export const cloneProfile = (profile: HostProfile): HostProfile => ({
  ...profile,
  password: profile.password,
  key_path: profile.key_path,
  key_pass: profile.key_pass,
});

export const resolveEffectiveProfile = (
  mode: Mode,
  profileOverride?: HostProfile | null,
): HostProfile | null => {
  if (profileOverride) return cloneProfile(profileOverride);
  if (mode.kind === "remote") return cloneProfile(mode.profile);
  return null;
};

export const isRemoteLike = (mode: Mode, profileOverride?: HostProfile | null): boolean =>
  resolveEffectiveProfile(mode, profileOverride) !== null;

export const scopeKeyForProfile = (profile?: HostProfile | null): string => {
  if (!profile) return "local";
  const port = profile.port ?? 22;
  return `remote:${profile.user}@${profile.host}:${port}`;
};

export const sessionCacheKeyForScope = (scope: string, session: string): string => `${scope}/${session}`;

export const sessionCacheKey = (session: string, profile?: HostProfile | null): string =>
  sessionCacheKeyForScope(scopeKeyForProfile(profile), session);

export const renameWindowsCacheEntry = (
  cache: Map<string, TmuxWindow[]>,
  scope: string,
  oldSession: string,
  newSession: string,
): void => {
  if (oldSession === newSession) return;
  const oldKey = sessionCacheKeyForScope(scope, oldSession);
  const existing = cache.get(oldKey);
  if (!existing) return;
  cache.delete(oldKey);
  cache.set(sessionCacheKeyForScope(scope, newSession), existing);
};

const REMOTE_TIMEOUT_MS = 12000;

const escapeArg = (value: string) => {
  if (/^[A-Za-z0-9_@:\-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
};

const WINDOW_FORMAT = '#{window_index}\t#{window_id}\t#{window_name}\t#{?window_active,1,0}\t#{window_panes}';

const buildListWindowsCommand = (session: string) =>
  `list-windows -t ${escapeArg(session)} -F "${WINDOW_FORMAT}"`;

const buildCapturePaneCommand = (target: string, lines = 200) =>
  `capture-pane -p -t ${escapeArg(target)} -S -${Math.abs(lines)} -J`;

export const buildSendKeysControlCommand = (
  target: string,
  keys: string,
  withEnter: boolean,
): string[] => {
  const literal = `send-keys -t ${escapeArg(target)} -l ${escapeArg(keys)}`;
  if (!withEnter) return [literal];
  const enter = `send-keys -t ${escapeArg(target)} Enter`;
  return [literal, enter];
};

const decodeTmuxData = (chunks: string[]): string => {
  const joined = chunks.join("");
  const octalReplaced = joined.replace(/\\(\d{3})/g, (_, digits) =>
    String.fromCharCode(parseInt(digits, 8))
  );
  return octalReplaced.replace(/\\\\/g, "\\");
};

const parseWindowsData = (session: string, chunks: string[]): TmuxWindow[] => {
  const decoded = decodeTmuxData(chunks);
  return decoded
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const index = Number(parts[0] ?? "0");
      const id = parts[1]?.trim() || "";
      const name = parts[2] ?? "";
      const active = (parts[3] ?? "0") === "1";
      const panes = Number(parts[4] ?? "1");
      return { index, id, name, active, panes };
    });
};

export default function Runs() {
  // --- state/refs ---
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [msg, setMsg] = useState("");
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [windows, setWindows] = useState<TmuxWindow[]>([]);
  const [activeWin, setActiveWin] = useState<number | null>(null);
  const [activeWinId, setActiveWinId] = useState<string | null>(null);
  const [paneText, setPaneText] = useState("");
  const [newSession, setNewSession] = useState("arc");
  const [newWinName, setNewWinName] = useState("");
  const [newWinCmd, setNewWinCmd] = useState("");
  const [follow, setFollow] = useState(true);
  const [remoteCfg, setRemoteCfg] = useState<HostProfile | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "local" });
  const [pollPaused, setPollPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [controlSessionKey, setControlSessionKey] = useState<string | null>(null);
  const [controlDisconnected, setControlDisconnected] = useState(false);
  const inFlight = useRef({ listWindows: 0, capture: 0, sessions: 0 });
  const nameCacheRef = useRef(new Map<string, string>());
  const paneCacheRef = useRef(new Map<string, string>());
  const windowsCacheRef = useRef(new Map<string, TmuxWindow[]>());
  const remoteSessionToken = useRef(0);
  const remoteBadge =
    mode.kind === "remote"
      ? `${mode.profile.user}@${mode.profile.host}:${mode.profile.port ?? 22}`
      : "";
  const paneDivRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeWinRef = useRef<number | null>(null);
  const activeWinIdRef = useRef<string | null>(null);
  const controlRef = useRef<{ session: string; profile: HostProfile } | null>(null);
  const controlSessionKeyRef = useRef<string | null>(null);
  const controlStateRef = useRef<{ pending: ControlPending[]; inflight: Map<string, ControlPending> }>({
    pending: [],
    inflight: new Map(),
  });
  const controlStartedRef = useRef(false);
  const paneRefreshTimerRef = useRef<number | null>(null);
  const localBootstrapRef = useRef(false);

  useEffect(() => {
    activeWinRef.current = activeWin;
  }, [activeWin]);

  useEffect(() => {
    activeWinIdRef.current = activeWinId;
  }, [activeWinId]);

  useEffect(() => {
    if (!windows.length) {
      activeWinRef.current = null;
      activeWinIdRef.current = null;
      return;
    }
    const preferred =
      windows.find((w) => w.index === activeWin) ??
      windows.find((w) => w.active) ??
      windows[0];
    if (preferred) {
      activeWinRef.current = preferred.index;
      activeWinIdRef.current = preferred.id ?? null;
    }
  }, [windows, activeWin]);

  useEffect(() => {
    controlSessionKeyRef.current = controlSessionKey;
  }, [controlSessionKey]);

const controlSessionKeyFor = (profile: HostProfile, session: string) =>
  `${profile.user}@${profile.host}:${profile.port ?? 22}#${session}`;

const both = (args: Record<string, any>) => {
  const out = { ...args };
  if ("window_index" in out) out.windowIndex = out.window_index;
  if ("with_enter" in out) out.withEnter = out.with_enter;
  if ("window_id" in out) out.windowId = out.window_id;
  return out;
};
const r = (payload: Record<string, any>, profileOverride?: HostProfile | null) => {
  const profile = resolveEffectiveProfile(mode, profileOverride);
  if (!profile) {
    throw new Error("remote profile unavailable");
  }
  return { profile, ...payload };
};

function withTimeout<T>(p: Promise<T>, ms = 6000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

const api = {
  listSessions: async (): Promise<Session[]> =>
    mode.kind === "remote" ? invoke("remote_tmux_list_sessions", r({})) : invoke("tmux_list_sessions"),

  listWindows: async (session: string, profileOverride?: HostProfile | null): Promise<TmuxWindow[]> => {
    const profile = resolveEffectiveProfile(mode, profileOverride);
    if (profile) {
      return invoke("remote_tmux_list_windows", { profile, session });
    }
    return invoke("tmux_list_windows", { session });
  },

  capturePane: async (
    session: string,
    windowIndex: number,
    windowId?: string | null,
    lines = 200,
    profileOverride?: HostProfile | null,
  ): Promise<string> => {
    const args: Record<string, any> = { session, window_index: windowIndex, lines };
    if (windowId) args.window_id = windowId;
    const profile = resolveEffectiveProfile(mode, profileOverride);
    if (profile) {
      return invoke("remote_tmux_capture_pane", { payload: { ...both(args), profile } });
    }
    return invoke("tmux_capture_pane", { payload: args });
  },
  sendKeys: async (session: string, windowIndex: number, keys: string, withEnter = true, windowId?: string | null) => {
    if (mode.kind === "remote" && controlReady()) {
      const target = windowId?.trim() && windowId.trim().length
        ? windowId.trim()
        : `${session}:${windowIndex}`;
      const commands = buildSendKeysControlCommand(target, keys, withEnter);
      for (const command of commands) {
        await sendControlCommand(command);
      }
      return;
    }

    const args: Record<string, any> = { session, window_index: windowIndex, keys, with_enter: withEnter };
    if (windowId) args.window_id = windowId;
    return mode.kind === "remote"
      ? invoke("remote_tmux_send_keys", { payload: r(both(args)) })
      : invoke("tmux_send_keys", { payload: args });
  },

  newWindow: async (session: string, name?: string, cmd?: string) => {
    const args = { session, name: name ?? null, cmd: cmd ?? null };
    return mode.kind === "remote"
      ? invoke("remote_tmux_new_window", r(args))
      : invoke("tmux_new_window", args);
  },

  renameSession: async (session: string, newName: string) =>
    mode.kind === "remote"
      ? invoke("remote_tmux_rename_session", {
          payload: { profile: (mode as any).profile, session, new_name: newName },
        })
      : invoke("tmux_rename_session", { payload: { session, new_name: newName } }),

  killWindow: async (session: string, windowIndex: number, windowId?: string | null) => {
    const args: Record<string, any> = { session, window_index: windowIndex };
    if (windowId) args.window_id = windowId;
    return mode.kind === "remote"
      ? invoke("remote_tmux_kill_window", { payload: r(both(args)) })
      : invoke("tmux_kill_window", { payload: args });
  },

  renameWindow: async (session: string, windowIndex: number, newName: string, windowId?: string | null) => {
    if (mode.kind === "remote") {
      const args: Record<string, any> = { session, window_index: windowIndex, new_name: newName };
      if (windowId) args.window_id = windowId;
      return invoke("remote_tmux_rename_window", { payload: r(both(args)) });
    }
    return invoke("tmux_rename_window", { payload: { session, window_index: windowIndex, new_name: newName } });
  },

  startControl: async (session: string, profile: HostProfile) =>
    invoke("remote_tmux_control_start", { profile, session }),

  stopControl: async (session: string, profile: HostProfile) =>
    invoke("remote_tmux_control_stop", { profile, session }),

  controlSend: async (session: string, command: string, profile: HostProfile) =>
    invoke("remote_tmux_control_send", { profile, session, command }),

  startServer: async () =>
    mode.kind === "remote" ? invoke("remote_tmux_start_server", { profile: (mode as any).profile }) : invoke("tmux_start_server"),

  newSession: async (session: string) =>
    mode.kind === "remote" ? invoke("remote_tmux_new_session", { profile: (mode as any).profile, session }) : invoke("tmux_new_session", { session }),

  killSession: async (session: string) =>
    mode.kind === "remote" ? invoke("remote_tmux_kill_session", { profile: (mode as any).profile, session }) : invoke("tmux_kill_session", { session }),
};

const startControlSession = (sessionName: string, profile: HostProfile) => {
  const cloned = cloneProfile(profile);
  controlRef.current = { session: sessionName, profile: cloned };
  const key = controlSessionKeyFor(cloned, sessionName);
  controlSessionKeyRef.current = key;
  setControlSessionKey(key);
  setControlDisconnected(false);
  controlStartedRef.current = false;
  resetControlQueues();
  void api
    .startControl(sessionName, cloned)
    .catch((err) => {
      console.error("control start failed", err);
      setControlDisconnected(true);
      setMsg(`⚠️ Control session start failed: ${String(err)}`);
    });
};

const stopControlSession = () => {
  if (!controlRef.current) return;
  const { session, profile } = controlRef.current;
  resetControlQueues();
  void api.stopControl(session, profile).catch((err) => {
    console.error("control stop failed", err);
  });
  setControlSessionKey(null);
  controlSessionKeyRef.current = null;
  setControlDisconnected(false);
  controlStartedRef.current = false;
};

const resetControlQueues = (reason?: string) => {
  const state = controlStateRef.current;
  const error = reason ? new Error(reason) : new Error("control session reset");
  while (state.pending.length) {
    const entry = state.pending.shift();
    if (entry) entry.reject(error);
  }
  state.inflight.forEach((entry) => entry.reject(error));
  state.inflight.clear();
};

function handleControlLine(line: string) {
  const state = controlStateRef.current;
  if (line.startsWith("%%begin ")) {
    const parts = line.split(" ");
    const tag = parts[1];
    const entry = state.pending.shift();
    if (entry) {
      state.inflight.set(tag, entry);
    } else {
      console.warn("tmux control: unexpected %%begin with tag", tag);
    }
    return;
  }

  if (line.startsWith("%%data ")) {
    const rest = line.slice("%%data ".length);
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) return;
    const tag = rest.slice(0, spaceIdx);
    const data = rest.slice(spaceIdx + 1);
    const entry = state.inflight.get(tag);
    if (entry) {
      entry.data.push(data);
    }
    return;
  }

  if (line.startsWith("%%end ")) {
    const parts = line.split(" ");
    const tag = parts[1];
    const status = parts[2] ?? "0";
    const entry = state.inflight.get(tag);
    if (entry) {
      state.inflight.delete(tag);
      if (status === "0") {
        entry.resolve(entry.data);
      } else {
        entry.reject(new Error(entry.data.join("\n") || `tmux error ${status}`));
      }
    }
    return;
  }

  if (line.startsWith("%window-") || line.startsWith("%session-")) {
    const current = controlRef.current;
    if (current) {
      void (async () => {
        await loadWindows(current.session);
        schedulePaneRefresh();
      })();
    }
    return;
  }

  if (line.startsWith("%output")) {
    if (mode.kind === "remote") schedulePaneRefresh();
    return;
  }

  if (line.startsWith("%error")) {
    console.error("tmux control error", line);
    return;
  }
}

const sendControlCommand = (command: string): Promise<string[]> => {
  const control = controlRef.current;
  if (!control || !controlSessionKeyRef.current) {
    return Promise.reject(new Error("control session inactive"));
  }

  return new Promise((resolve, reject) => {
    const entry: ControlPending = { command, resolve, reject, data: [] };
    controlStateRef.current.pending.push(entry);
    api
      .controlSend(control.session, command, control.profile)
      .catch((err) => {
        const pending = controlStateRef.current.pending;
        const idx = pending.indexOf(entry);
        if (idx !== -1) pending.splice(idx, 1);
        const error = err instanceof Error ? err : new Error(String(err));
        setControlDisconnected(true);
        setMsg(`⚠️ Control command failed: ${error.message}`);
        reject(error);
      });
  });
};

const controlReady = () =>
  mode.kind === "remote" &&
  !controlDisconnected &&
  controlRef.current !== null &&
  controlSessionKeyRef.current !== null &&
  controlStartedRef.current;

const waitForControlReady = async (timeoutMs = 3000) => {
  if (controlReady()) return;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (controlReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("control session not ready");
};

const getWindows = async (
  session: string,
  profileOverride?: HostProfile | null,
): Promise<TmuxWindow[]> => {
  if (controlReady()) {
    try {
      const chunks = await sendControlCommand(buildListWindowsCommand(session));
      return parseWindowsData(session, chunks);
    } catch (err) {
      console.error("control list-windows failed", err);
      stopControlSession();
    }
  }

  return await withTimeout(
    api.listWindows(session, profileOverride),
    isRemoteLike(mode, profileOverride) ? REMOTE_TIMEOUT_MS : 6000,
  );
};

const getPane = async (
  session: string,
  index: number | null,
  id: string | null,
  lines = 200,
  profileOverride?: HostProfile | null,
): Promise<string> => {
  const safeIndex = index ?? 0;
  if (controlReady()) {
    try {
      const target = id?.trim() && id.trim().length ? id.trim() : `${session}:${safeIndex}`;
      const chunks = await sendControlCommand(buildCapturePaneCommand(target, lines));
      return decodeTmuxData(chunks);
    } catch (err) {
      console.error("control capture-pane failed", err);
      stopControlSession();
    }
  }

  return await withTimeout(
    api.capturePane(session, safeIndex, id, lines, profileOverride),
    isRemoteLike(mode, profileOverride) ? REMOTE_TIMEOUT_MS : 6000,
  );
};

const refreshPaneForCurrent = async () => {
  if (!activeSession) return;
  const indexTarget = activeWinRef.current ?? activeWin;
  if (indexTarget === null || indexTarget === undefined) return;
  const pane = await getPane(activeSession, indexTarget, activeWinIdRef.current ?? activeWinId);
  const key = paneKeyFromParts(activeSession, indexTarget, activeWinIdRef.current ?? activeWinId);
  paneCacheRef.current.set(key, pane || " ");
  setPaneText(pane || " ");
};

const schedulePaneRefresh = () => {
  if (paneRefreshTimerRef.current) {
    window.clearTimeout(paneRefreshTimerRef.current);
  }
  paneRefreshTimerRef.current = window.setTimeout(() => {
    paneRefreshTimerRef.current = null;
    void refreshPaneForCurrent();
  }, 80) as unknown as number;
};


  const cacheScope = (profileOverride?: HostProfile | null) => {
    if (profileOverride) return scopeKeyForProfile(profileOverride);
    if (mode.kind !== "remote") return "local";
    return scopeKeyForProfile(mode.profile);
  };

  const cacheKeyFor = (sessionName: string, w: TmuxWindow, profileOverride?: HostProfile | null): string =>
    buildWindowCacheKey(cacheScope(profileOverride), sessionName, w.index, w.id ?? null);

  const paneKeyFromParts = (
    sessionName: string,
    index: number,
    id?: string | null,
    profileOverride?: HostProfile | null,
  ): string => buildWindowCacheKey(cacheScope(profileOverride), sessionName, index, id ?? null);

  const normalizeWindows = (sessionName: string, ws: TmuxWindow[]): TmuxWindow[] => {
    const byKey = new Map<string, TmuxWindow>();

    for (const w of ws) {
      const trimmedId = w.id?.trim() ?? "";
      const key = trimmedId ? `id:${trimmedId}` : `idx:${w.index}`;
      const cacheKey = cacheKeyFor(sessionName, w);
      let trimmedName = (w.name ?? "").trim();

      if (trimmedName.length) {
        nameCacheRef.current.set(cacheKey, trimmedName);
      } else {
        const cached = nameCacheRef.current.get(cacheKey);
        if (cached) trimmedName = cached;
      }

      const candidate: TmuxWindow = {
        ...w,
        id: trimmedId || w.id,
        name: trimmedName,
      };

      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, candidate);
        continue;
      }

      const existingName = (existing.name ?? "").trim();
      const candidateName = trimmedName;
      const useCandidate =
        candidateName.length > existingName.length ||
        (candidateName.length === existingName.length && candidate.active && !existing.active);

      if (useCandidate) {
        byKey.set(key, candidate);
      }
    }

    return Array.from(byKey.values()).sort((a, b) => a.index - b.index);
  };

  const getDisplayName = (w: TmuxWindow): string => (w.name ?? "").trim();

  // --- loaders (TOP-LEVEL) ---
  async function refreshSessions() {
    setSessionLoading(true);
    setMsg(mode.kind === "remote" ? `Connecting to ${remoteBadge}…` : "");
    const token = ++inFlight.current.sessions;
    try {
      const s = await withTimeout(api.listSessions(), mode.kind === "remote" ? REMOTE_TIMEOUT_MS : 6000);
      if (token !== inFlight.current.sessions) return; // stale
      setSessions(s);
      const scope = cacheScope();
      const allowed = new Set(s.map((x) => x.name));
      const pruneBySessions = <T,>(map: Map<string, T>) => {
        for (const key of Array.from(map.keys())) {
          if (!key.startsWith(`${scope}/`)) continue;
          const rest = key.slice(scope.length + 1);
          const sessionKey = rest.split("/")[0] ?? "";
          if (!allowed.has(sessionKey)) map.delete(key);
        }
      };
      pruneBySessions(nameCacheRef.current);
      pruneBySessions(paneCacheRef.current);
      pruneBySessions(windowsCacheRef.current);
      const keep = activeSession && s.some((x) => x.name === activeSession);
      if (!keep) {
        if (s.length) {
          if (mode.kind === "remote") {
            selectSession(s[0].name);
          } else {
            setActiveSession(s[0].name);
            setActiveWin(null);
            setActiveWinId(null);
            setPaneText("");
          }
        } else {
          setActiveSession(null);
          setActiveWin(null);
          setActiveWinId(null);
          setPaneText("");
        }
      }
      setMsg("");
    } catch (e: any) {
      if (token !== inFlight.current.sessions) return;
      setMsg(`⚠️ Failed to read tmux sessions: ${String(e?.message ?? e)}`);
      setSessions([]);
      setActiveSession(null);
      setActiveWin(null);
      setActiveWinId(null);
    } finally {
      setSessionLoading(false);
    }
  }

async function loadWindows(session: string) {
  try {
    const ws = await getWindows(session);
    console.debug("listWindows raw", session, ws);
    const normalized = normalizeWindows(session, ws);
    console.debug("loadWindows", session, normalized);
    setWindows(normalized);
    windowsCacheRef.current.set(sessionCacheKeyForScope(cacheScope(), session), normalized);
    pruneWindowCache(paneCacheRef.current, cacheScope(), session, normalized);
    const currentActive = activeWinRef.current;
    if (!normalized.length) {
      setActiveWin(null);
      setActiveWinId(null);
      setPaneText("");
      setMsg(`⚠️ No windows reported for "${session}". If this is unexpected, click Refresh.`);
      activeWinRef.current = null;
      activeWinIdRef.current = null;
    } else if (currentActive === null || !normalized.some(w => w.index === currentActive)) {
      setActiveWin(normalized[0].index);
      setActiveWinId(normalized[0].id);
      activeWinRef.current = normalized[0].index;
      activeWinIdRef.current = normalized[0].id ?? null;
    } else {
      const current = normalized.find(w => w.index === currentActive);
      if (current) {
        setActiveWinId(current.id);
        activeWinRef.current = current.index;
        activeWinIdRef.current = current.id ?? null;
      }
    }
  } catch (e: any) {
    setMsg(`⚠️ Failed to list windows: ${String(e?.message ?? e)}`);
  }
}
  function selectSession(sessionName: string, profileOverride?: HostProfile | null) {
    if (!sessionName) return;

    if (mode.kind !== "remote" && !profileOverride) {
      setActiveSession(sessionName);
      return;
    }

    if (sessionName === activeSession && !profileOverride) return;

    setActiveSession(sessionName);

    const profile = profileOverride ?? (mode.kind === "remote" ? mode.profile : null);
    if (!profile) return;

    if (mode.kind === "remote") {
      if (!controlRef.current || controlRef.current.session !== sessionName) {
        stopControlSession();
        startControlSession(sessionName, profile);
      }
    }

    setSessionLoading(true);
    setMsg(`Loading ${sessionName}…`);
    setPollPaused(true);
    const scope = cacheScope(profile);
    const cacheKey = sessionCacheKeyForScope(scope, sessionName);
    const cachedWindows = windowsCacheRef.current.get(cacheKey) ?? null;

    setActiveWin(null);
    setActiveWinId(null);

    if (cachedWindows && cachedWindows.length) {
      setWindows(cachedWindows);
      const cachedPreferred = cachedWindows.find((w) => w.active) ?? cachedWindows[0] ?? null;
      if (cachedPreferred) {
        setActiveWin(cachedPreferred.index);
        setActiveWinId(cachedPreferred.id ?? null);
        activeWinRef.current = cachedPreferred.index;
        activeWinIdRef.current = cachedPreferred.id ?? null;
        const cachedPane = paneCacheRef.current.get(cacheKeyFor(sessionName, cachedPreferred, profile));
        setPaneText(cachedPane ?? "Loading…");
      } else {
        setPaneText("Loading…");
      }
    } else {
      setWindows([]);
      setPaneText("Loading…");
    }

    const token = ++remoteSessionToken.current;

    void (async () => {
      try {
        const rawWindows = await getWindows(sessionName, profile);
        if (token !== remoteSessionToken.current) return;

        const normalized = normalizeWindows(sessionName, rawWindows);
        console.debug("selectSession update", sessionName, normalized);
        windowsCacheRef.current.set(cacheKey, normalized);

        const preferred = normalized.find((w) => w.active) ?? normalized[0] ?? null;
        let pane = "";
        if (preferred) {
          const cached = paneCacheRef.current.get(cacheKeyFor(sessionName, preferred, profile));
          if (cached) setPaneText(cached);
          pane = await getPane(sessionName, preferred.index, preferred.id ?? null, 200, profile);
          paneCacheRef.current.set(cacheKeyFor(sessionName, preferred, profile), pane || " ");
        }
        if (token !== remoteSessionToken.current) return;

        setWindows(normalized);
        pruneWindowCache(paneCacheRef.current, scope, sessionName, normalized);
        if (preferred) {
          setActiveWin(preferred.index);
          setActiveWinId(preferred.id);
          activeWinRef.current = preferred.index;
          activeWinIdRef.current = preferred.id ?? null;
          setPaneText(pane || " ");
        } else {
          setActiveWin(null);
          setActiveWinId(null);
          activeWinRef.current = null;
          activeWinIdRef.current = null;
          setPaneText(" ");
        }

        if (!normalized.length) {
          setMsg(`⚠️ No windows reported for "${sessionName}". If this is unexpected, click Refresh.`);
        } else {
          setMsg("");
        }
      } catch (e: any) {
        if (token !== remoteSessionToken.current) return;
        const raw = String(e?.message ?? e ?? "");
        setMsg(`⚠️ Failed to load "${sessionName}": ${raw}`);
        setPaneText(`<< ${raw} >>`);
      } finally {
        if (token === remoteSessionToken.current) {
          setPollPaused(false);
          setSessionLoading(false);
        }
      }
    })();
  }

  function resetUiForMode() {
    setSessions(null);
    setWindows([]);
    setActiveSession(null);
    setActiveWin(null);
    setActiveWinId(null);
    setPaneText("");
    setMsg("");
    setRemoteLoading(false);
    setSessionLoading(false);
    nameCacheRef.current.clear();
    paneCacheRef.current.clear();
    windowsCacheRef.current.clear();
    remoteSessionToken.current++;
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }


  // --- guarded remote switch (TOP-LEVEL) ---
  async function switchToRemote(profile: HostProfile) {
    stopControlSession();
    resetUiForMode();  // clear all local state so UI doesn't mix Local + Remote

    setRemoteLoading(true);
    setSessionLoading(true);

    const baseProfile: HostProfile = { ...profile };
    const connectMsg = `Connecting to ${profile.user}@${profile.host}:${profile.port ?? 22}…`;
    setMode({ kind: "remote", profile: baseProfile });
    setMsg(connectMsg);

    try {
      const pw = profile.auth === "password" ? await getRemotePassword() : undefined;
      const prof: HostProfile = { ...profile, password: pw };
      setMode({ kind: "remote", profile: prof });
      setMsg(connectMsg);

      // 🔹 Step 1: quick ping test (forces SSH connection + shows you if it's hanging)
      const ping = await withTimeout(invoke<string>("remote_ping", { profile: prof }), REMOTE_TIMEOUT_MS);
      setMsg(`Connected to ${prof.user}@${prof.host} — ${ping}`);

      // 🔹 Step 2: fetch sessions *explicitly* using this profile (not via api.listSessions)
      const s = await withTimeout(invoke<Session[]>("remote_tmux_list_sessions", { profile: prof }), REMOTE_TIMEOUT_MS);

      // 🔹 Step 3: update your UI
      setSessions(s);
      setRemoteLoading(false);
      if (s.length) {
        startControlSession(s[0].name, prof);
        selectSession(s[0].name, prof);
      } else {
        setActiveSession(null);
        setMsg(`Found 0 tmux session(s) on ${prof.host}`);
        setSessionLoading(false);
      }
    } catch (e: any) {
      setMsg(`⚠️ Remote error: ${String(e?.message ?? e)}`);
      setPaneText(`<< remote error: ${String(e)} >>`);
      setMode({ kind: "local" });
      setRemoteLoading(false);
      setSessionLoading(false);
    }
  }

function switchToLocal() {
  stopControlSession();
  resetUiForMode();
  setMode({ kind: "local" });
  // fetch local sessions once right after switching
  void (async () => {
    try {
      const s = await withTimeout(api.listSessions());
      setSessions(s);
      setActiveSession(s.length ? s[0].name : null);
    } catch (e: any) {
      setMsg(`⚠️ Local tmux read failed: ${String(e?.message ?? e)}`);
    }
  })();
}


  // --- actions (TOP-LEVEL) ---
  async function onStartServer() { await api.startServer(); await refreshSessions(); }
  async function onCreateSession() {
    const name = newSession.trim();
    if (!name) {
      setMsg("⚠️ Session name required.");
      return;
    }
    if ((sessions ?? []).some((s) => s.name === name)) {
      setMsg(`⚠️ Session "${name}" already exists.`);
      return;
    }

    try {
      setBusy(true);
      setPollPaused(true);
      if (mode.kind === "remote") {
        setMsg(`Creating remote session "${name}"…`);
      }
      await api.newSession(name);

      const s = await withTimeout(api.listSessions(), mode.kind === "remote" ? REMOTE_TIMEOUT_MS : 6000);
      setSessions(s);

      if (s.some((x) => x.name === name)) {
        if (mode.kind === "remote") {
          selectSession(name);
        } else {
          setActiveSession(name);
          setActiveWin(null);
          setActiveWinId(null);
          setPaneText("");
        }
      }
      if (mode.kind !== "remote") setMsg("");
    } catch (e: any) {
      setMsg(`⚠️ Add session failed: ${String(e?.message ?? e)}`);
    } finally {
      setBusy(false);
      setPollPaused(false);
    }
  }

  async function onKillSession() {
    if (!activeSession) return;
    const scope = cacheScope();
    clearWindowCacheForSession(nameCacheRef.current, scope, activeSession);
    clearWindowCacheForSession(paneCacheRef.current, scope, activeSession);
    windowsCacheRef.current.delete(sessionCacheKeyForScope(scope, activeSession));
    await api.killSession(activeSession);
    setActiveSession(null);
    await refreshSessions();
  }

  async function onRenameSession(sessionName: string) {
    const proposed = window.prompt("Rename session", sessionName);
    const next = proposed?.trim();
    if (!next || next === sessionName) return;
    if ((sessions ?? []).some((s) => s.name === next)) {
      setMsg(`⚠️ Session "${next}" already exists.`);
      return;
    }
    setBusy(true);
    setPollPaused(true);
    setSessionLoading(true);
    try {
      let renameErr: any = null;
      try {
        await api.renameSession(sessionName, next);
      } catch (err) {
        renameErr = err;
      }

      const refreshed = await withTimeout(
        api.listSessions(),
        mode.kind === "remote" ? REMOTE_TIMEOUT_MS : 6000,
      );
      setSessions(refreshed);

      const scope = cacheScope();
      const renamed = refreshed.some((s) => s.name === next);
      if (renamed) {
        renameSessionInCache(nameCacheRef.current, scope, sessionName, next);
        renameSessionInCache(paneCacheRef.current, scope, sessionName, next);
        renameWindowsCacheEntry(windowsCacheRef.current, scope, sessionName, next);

        if (activeSession === sessionName) {
          setActiveSession(next);
          if (mode.kind === "remote") {
            selectSession(next);
          }
        }
        setMsg(`Renamed session to "${next}".`);
        return;
      }

      if (renameErr) {
        throw renameErr;
      }

      setMsg(`⚠️ Session rename did not apply ("${next}" not found).`);
    } catch (e: any) {
      setMsg(`⚠️ Rename session failed: ${String(e?.message ?? e)}`);
    } finally {
      setBusy(false);
      setPollPaused(false);
      setSessionLoading(false);
    }
  }
async function onCreateWindow() {
  if (!activeSession) return;
  try {
    setBusy(true);
    setPollPaused(true);
    await api.newWindow(activeSession, newWinName || undefined, newWinCmd || undefined);
    await loadWindows(activeSession);
    await refreshPaneForCurrent();
    setMsg("");
    setNewWinName("");
    setNewWinCmd("");
  } catch (e: any) {
    setMsg(`⚠️ Add window failed: ${String(e?.message ?? e)}`);
  } finally {
    setBusy(false);
    setPollPaused(false);
  }
}

async function onSendKeys(keys: string, enter = true) {
  if (!activeSession || activeWin === null) return;
  try {
    setBusy(true);
    // optionally pause only for a short moment to let remote process the command
    setPollPaused(true);
    const win = await ensureWindow(activeWin);
    if (!win) {
      setMsg("⚠️ Active window could not be resolved.");
      return;
    }
    const targetId = mode.kind === "remote" ? (win.id || null) : null;
    if (mode.kind === "remote" && !targetId) {
      setMsg("⚠️ Remote window id unavailable; please refresh sessions.");
      return;
    }
    setActiveWin(win.index);
    setActiveWinId(targetId);
    await api.sendKeys(activeSession, win.index, keys, enter, targetId);
    if (mode.kind === "remote") void refreshPaneForCurrent();
  } catch (e: any) {
    setMsg(`⚠️ Send keys failed: ${String(e?.message ?? e)}`);
  } finally {
    setBusy(false);
    // tiny delay to let command output land before next poll
    setTimeout(() => setPollPaused(false), 200);
  }
}

  async function onKillWindow(idx: number) {
    if (!activeSession) return;
    let ok = true;
    try { ok = await ask(`Close window ${idx} in "${activeSession}"?`, { title: "Close window", kind: "warning" }); }
    catch { ok = window.confirm(`Close window ${idx} in "${activeSession}"?`); }
    if (!ok) return;
    try {
      const win = await ensureWindow(idx);
      const targetId = mode.kind === "remote" ? (win?.id ?? null) : null;
      if (mode.kind === "remote" && !targetId) {
        setMsg("⚠️ Remote window id unavailable; please refresh sessions.");
        return;
      }
      if (win) {
        nameCacheRef.current.delete(cacheKeyFor(activeSession, win));
      }
      await api.killWindow(activeSession, idx, targetId);
      setActiveWin(null);
      setActiveWinId(null);
      await loadWindows(activeSession);
      await refreshPaneForCurrent();
      await refreshSessions();
    } catch (e: any) {
      setMsg(`⚠️ Kill window failed: ${String(e?.message ?? e)}`);
    }
  }
  async function onRenameWindow(idx: number) {
    if (!activeSession) return;
    const newName = window.prompt("New window name:", "");
    if (!newName) return;
    const win = await ensureWindow(idx);
    const targetId = mode.kind === "remote" ? (win?.id ?? null) : null;
    if (mode.kind === "remote" && !targetId) {
      setMsg("⚠️ Remote window id unavailable; please refresh sessions.");
      return;
    }
    await api.renameWindow(activeSession, idx, newName, targetId);
    if (win) {
      nameCacheRef.current.set(cacheKeyFor(activeSession, win), newName.trim());
    }
    await loadWindows(activeSession);
    await refreshPaneForCurrent();
  }

  async function ensureWindow(index: number): Promise<TmuxWindow | null> {
    let win = windows.find((w) => w.index === index) ?? null;
    if (mode.kind !== "remote" || !activeSession) return win;
    if (win?.id) return win;
    try {
      const remoteWins = await getWindows(activeSession);
      console.debug("ensureWindow raw", remoteWins);
      const normalized = normalizeWindows(activeSession, remoteWins);
      console.debug("ensureWindow list", activeSession, normalized);
      setWindows(normalized);
      windowsCacheRef.current.set(
        sessionCacheKeyForScope(cacheScope(), activeSession),
        normalized,
      );
      pruneWindowCache(paneCacheRef.current, cacheScope(), activeSession, normalized);
      const refreshed = normalized.find((w) => w.index === index) ?? null;
      if (refreshed && index === activeWin) {
        setActiveWin(refreshed.index);
        setActiveWinId(refreshed.id ?? null);
      }
      return refreshed;
    } catch {
      return win;
    }
  }

  // --- effects ---
  useEffect(() => {
    if (mode.kind !== "local") {
      localBootstrapRef.current = false;
      return;
    }
    if (sessions !== null || localBootstrapRef.current) return;
    localBootstrapRef.current = true;
    void refreshSessions();
  }, [mode.kind, sessions]);

  // 1) cancel interval whenever mode changes
  useEffect(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [mode]);



  // 3) windows when session/mode changes
  useEffect(() => {
    if (!activeSession || mode.kind !== "local") return;
    let cancelled = false;
    void (async () => {
      await loadWindows(activeSession);
      if (!cancelled) await refreshPaneForCurrent();
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSession, mode.kind]);

  // 4) pane poller
  useEffect(() => {
    if (mode.kind === "remote") return;
    if (!activeSession || activeWin === null || pollPaused) return;

    let cancelled = false;
    const baseDelay = follow ? 2000 : 4000;

    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    const tick = async (): Promise<number> => {
      if (cancelled) return baseDelay;
      if (!activeSession) return baseDelay;

      let indexTarget = activeWinRef.current ?? activeWin;
      let idTarget = activeWinIdRef.current ?? activeWinId;

      if ((indexTarget === null || indexTarget === undefined) && (!idTarget || !idTarget.trim())) {
        const fallback =
          windows.find((w) => w.index === activeWin) ??
          windows.find((w) => w.active) ??
          windows[0] ??
          null;
        if (fallback) {
          indexTarget = fallback.index;
          idTarget = fallback.id ?? null;
          activeWinRef.current = fallback.index;
          activeWinIdRef.current = fallback.id ?? null;
        }
      }

      if (indexTarget === null || indexTarget === undefined) {
        return baseDelay;
      }

      try {
        console.debug("refresh target", { indexTarget, idTarget });
        if (mode.kind === "remote" && controlReady()) {
          const pane = await getPane(activeSession, indexTarget, idTarget ?? null);
          if (cancelled) return baseDelay;
          const key = paneKeyFromParts(activeSession, indexTarget, idTarget ?? null);
          paneCacheRef.current.set(key, pane || " ");
          setPaneText(pane || " ");
          setMsg((prev) => (prev.startsWith("⚠️ Remote") ? "" : prev));
          return baseDelay;
        }

        const [list, pane] = await Promise.all([
          getWindows(activeSession),
          getPane(activeSession, indexTarget, idTarget ?? null),
        ]);
        if (cancelled) return baseDelay;
        const normalized = normalizeWindows(activeSession, list);
        setWindows(normalized);
        pruneWindowCache(paneCacheRef.current, cacheScope(), activeSession, normalized);
        const key = paneKeyFromParts(activeSession, indexTarget, idTarget ?? null);
        paneCacheRef.current.set(key, pane || " ");
        setPaneText(pane || " ");
        if (!normalized.some((w) => w.index === indexTarget) && normalized.length) {
          setActiveWin(normalized[0].index);
          setActiveWinId(normalized[0].id);
          activeWinRef.current = normalized[0].index;
          activeWinIdRef.current = normalized[0].id ?? null;
        } else {
          const current = normalized.find((w) => w.index === indexTarget);
          if (current) {
            setActiveWinId(current.id);
            activeWinRef.current = current.index;
            activeWinIdRef.current = current.id ?? null;
          }
        }
        setMsg((prev) => (prev.startsWith("⚠️ Remote") ? "" : prev));
        return baseDelay;
      } catch (e: any) {
        if (!cancelled) {
          const text = String(e?.message ?? e ?? "");
          setMsg(`⚠️ Refresh failed: ${text}`);
        }
        return baseDelay;
      }
    };

    const loop = async () => {
      console.debug("poll tick start", { activeSession, activeWin, activeWinId });
      const delay = await tick();
      if (cancelled) return;
      timerRef.current = window.setTimeout(loop, delay) as unknown as number;
    };

    void loop();

    return () => {
      cancelled = true;
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [activeSession, activeWin, activeWinId, follow, mode, pollPaused, windows]);

  // 5) load remote cfg once
  useEffect(() => {
    (async () => {
      const cfg = await safeLoadConfig();
      setRemoteCfg((cfg.remote ?? null) as HostProfile | null);
    })();
  }, []);


  useEffect(() => {
    const off = onRemotePasswordChange(() => {});
    return () => { off(); };
  }, []);

  useEffect(() => {
    return () => {
      stopControlSession();
      if (paneRefreshTimerRef.current) {
        window.clearTimeout(paneRefreshTimerRef.current);
        paneRefreshTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (mode.kind !== "remote" || !controlSessionKey) return;

    let unlisten: UnlistenFn | null = null;

    const setup = async () => {
      try {
        unlisten = await listen<ControlEventPayload>("tmux-control-event", (event) => {
          const payload = event.payload as ControlEventPayload | null;
          if (!payload) return;
          if (payload.key !== controlSessionKeyRef.current) return;

          switch (payload.kind) {
            case "line":
              if (payload.line) handleControlLine(payload.line);
              break;
            case "started":
              resetControlQueues();
              setControlDisconnected(false);
              break;
            case "stopped":
            case "closed":
              resetControlQueues("control session stopped");
              setControlDisconnected(true);
              setControlSessionKey(null);
              controlSessionKeyRef.current = null;
              setMsg("⚠️ Control session lost. Click Reconnect.");
              break;
            case "error":
              console.error("tmux control error", payload.line);
              break;
            default:
              break;
          }
        });
      } catch (err) {
        console.error("control event listen failed", err);
      }
    };

    setup();

    return () => {
      if (unlisten) unlisten();
    };
  }, [mode.kind, controlSessionKey]);

  // ---- UI ----
  return (
    <div className="runs-page">
      <h2>Active ARC Runs</h2>
      <div className="runs-page__status">
        <div className="runs-page__status-remote" aria-live="polite">
          {mode.kind === "remote" ? (
            <>
              Remote: <code>{remoteBadge}</code>
            </>
          ) : (
            "\u00A0"
          )}
        </div>
        <div
          className={`runs-page__status-message${msg ? " runs-page__status-message--active" : ""}`}
          role="status"
          aria-live="polite"
        >
          {msg || "\u00A0"}
        </div>
      </div>

      {(remoteLoading || sessionLoading) && (
        <div className="loading-strip" role="progressbar" aria-hidden="true">
          <div className="loading-strip__bar" />
          <div className="loading-strip__pulse" />
        </div>
      )}

      <div className="toolbar">
        <div className="tabs-left" style={{ display: "flex", gap: 8 }}>
          <button
            className={`tab tab--condensed ${mode.kind === "local" ? "tab--active" : ""}`}
            onClick={switchToLocal}
            disabled={remoteLoading || sessionLoading}
          >Local</button>

          <button
            className={`tab tab--condensed ${mode.kind === "remote" ? "tab--active" : ""}`}
            onClick={() => remoteCfg && switchToRemote(remoteCfg)}
            disabled={!remoteCfg || remoteLoading || sessionLoading}
          >
            {remoteLoading
              ? "Remote (connecting…)"
              : sessionLoading
                ? "Remote (loading…)"
                : "Remote"}
          </button>
          {mode.kind === "remote" && controlDisconnected && controlRef.current && (
            <button
              className="btn btn--danger"
              onClick={() => {
                const current = controlRef.current;
                if (current) startControlSession(current.session, current.profile);
              }}
            >Reconnect control</button>
          )}
        </div>

        <div className="actions-right">
          <button className="btn" onClick={refreshSessions} disabled={busy || remoteLoading || sessionLoading}>Refresh</button>
          <button className="btn" onClick={onStartServer} disabled={busy || remoteLoading || sessionLoading}>Start server</button>
          <input className="input input--session" placeholder="new session"
                 value={newSession} onChange={(e) => setNewSession(e.target.value)} />
          <button className="btn" onClick={onCreateSession} disabled={busy || remoteLoading || sessionLoading}>Add session</button>
          {activeSession && <button className="btn btn--danger" onClick={onKillSession} disabled={busy || remoteLoading || sessionLoading}>Kill session</button>}
        </div>
      </div>

      {!!sessions?.length && (
        <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          {sessions.map((s) => (
            <button key={s.name}
              className={`tab tab--condensed ${s.name === activeSession ? "tab--active" : ""}`}
              onClick={() => selectSession(s.name)}
              onContextMenu={(e) => { e.preventDefault(); void onRenameSession(s.name); }}
              title={`${s.windows} ${s.windows === 1 ? "window" : "windows"} • Right-click to rename`}
              disabled={mode.kind === "remote" && (remoteLoading || sessionLoading)}
            >
              <span className="tab__label">{s.name}</span>
              <span className="badge">{s.windows}</span>
            </button>
          ))}
        </div>
      )}

      {activeSession &&
        windows.length === 0 &&
        !(mode.kind === "remote" && (sessionLoading || pollPaused)) && (
        <div style={{ opacity: 0.8, marginTop: 8 }}>
          No tmux windows yet. Click <b>Start server</b> (if needed) or <b>Add window</b>.
        </div>
      )}

      {activeSession && windows.length > 0 && (
        <div className="win-tabs">
          {windows.map((w, idx) => {
            const idPart = w.id?.trim();
            const key = idPart && idPart.length
              ? idPart
              : `${activeSession ?? ""}:${w.index}:${idx}`;
            const displayName = getDisplayName(w).trim();
            const label = displayName.length ? `${w.index}:${displayName}` : String(w.index);
            return (
            <div key={key} role="tab"
                 className={`win-tab ${w.index === activeWin ? "win-tab--active" : ""}`}
                 onClick={() => {
                   if (!activeSession) return;
                   if (mode.kind === "remote") {
                     const trimmedId = w.id?.trim();
                     const target = trimmedId && trimmedId.length ? trimmedId : `${activeSession}:${w.index}`;
                     if (controlReady()) {
                       void sendControlCommand(`select-window -t ${escapeArg(target)}`);
                     } else {
                       void invoke("remote_tmux_select_window", {
                         profile: (mode as any).profile,
                         session: activeSession,
                         target,
                       });
                     }
                   }
                   setActiveWin(w.index);
                   setActiveWinId(w.id);
                   activeWinRef.current = w.index;
                   activeWinIdRef.current = w.id ?? null;
                   const cachedKey = paneKeyFromParts(activeSession, w.index, w.id ?? null);
                   const cached = paneCacheRef.current.get(cachedKey);
                   if (cached) setPaneText(cached);
                   if (mode.kind === "remote") {
                     schedulePaneRefresh();
                   } else {
                     void refreshPaneForCurrent();
                   }
                 }}
                 onContextMenu={(e) => { e.preventDefault(); void onRenameWindow(w.index); }}
                 title={`${w.panes} ${w.panes === 1 ? "pane" : "panes"} • Right-click to rename`}>
              <span className="mono">{label}{w.active ? " •" : ""}</span>
              <button type="button" className="win-tab__close-btn" aria-label={`Close window ${w.index}`}
                      onClick={(e) => { e.stopPropagation(); void onKillWindow(w.index); }}>×</button>
            </div>
          );
          })}
          <div className="spacer" />
          <input className="input" style={{ width: 160 }} placeholder="new window name"
                 value={newWinName} onChange={(e) => setNewWinName(e.target.value)} />
          <input className="input" style={{ width: 240 }} placeholder="command (optional)"
                 value={newWinCmd} onChange={(e) => setNewWinCmd(e.target.value)} />
          <button className="btn" onClick={onCreateWindow} disabled={busy || remoteLoading || sessionLoading}>Add window</button>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", marginLeft: 8, fontSize: 12, opacity: 0.85 }}>
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Follow tail
          </label>
        </div>
      )}

      {activeSession && activeWin !== null && (
        <div className="pane mono" ref={paneDivRef}>
          {paneText || " "}
        </div>
      )}

      {activeSession && activeWin !== null && (
        <form onSubmit={async (e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem("cmd") as HTMLInputElement;
          const val = input.value;
          if (val.trim()) await onSendKeys(val, true);
          input.value = "";
        }}>
          <input name="cmd" placeholder="Type a command to send (Enter to send)"
                 style={{ width: "100%", padding: 8 }} />
        </form>
      )}
    </div>
  );
}
