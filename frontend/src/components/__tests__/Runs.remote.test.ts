import { describe, expect, it } from "vitest";
import {
  cloneProfile,
  resolveEffectiveProfile,
  isRemoteLike,
  scopeKeyForProfile,
  sessionCacheKey,
  sessionCacheKeyForScope,
  renameWindowsCacheEntry,
  buildSendKeysControlCommand,
  type HostProfile,
  type Mode,
  type TmuxWindow,
} from "../Runs";

describe("resolveEffectiveProfile", () => {
  const remoteProfile: HostProfile = {
    host: "remote.example",
    user: "arc",
    port: 2222,
    auth: "agent",
    key_path: "/tmp/key",
  };

  it("returns null for local mode without an override", () => {
    const localMode: Mode = { kind: "local" };
    expect(resolveEffectiveProfile(localMode)).toBeNull();
    expect(isRemoteLike(localMode)).toBe(false);
  });

  it("clones the active remote profile when already in remote mode", () => {
    const mode: Mode = { kind: "remote", profile: remoteProfile };
    const resolved = resolveEffectiveProfile(mode);
    expect(resolved).not.toBeNull();
    expect(resolved).not.toBe(remoteProfile);
    expect(resolved).toEqual(remoteProfile);

    if (!resolved) throw new Error("expected resolved profile");
    resolved.user = "other";
    resolved.port = 2022;
    expect(remoteProfile.user).toBe("arc");
    expect(remoteProfile.port).toBe(2222);
  });

  it("uses the override when provided in local mode", () => {
    const localMode: Mode = { kind: "local" };
    const override: HostProfile = {
      host: "override.example",
      user: "builder",
      auth: "password",
      password: "secret",
    };
    const resolved = resolveEffectiveProfile(localMode, override);
    expect(resolved).not.toBeNull();
    expect(resolved).not.toBe(override);
    expect(resolved).toEqual(override);

    if (!resolved) throw new Error("expected override profile");
    resolved.password = "changed";
    expect(override.password).toBe("secret");
    expect(isRemoteLike(localMode, override)).toBe(true);
  });

  it("prefers the override even when remote mode is active", () => {
    const mode: Mode = { kind: "remote", profile: remoteProfile };
    const override: HostProfile = { host: "alt.example", user: "alt" };
    const resolved = resolveEffectiveProfile(mode, override);
    expect(resolved).not.toBeNull();
    expect(resolved?.host).toBe("alt.example");
    expect(resolved?.user).toBe("alt");
    expect(resolved).not.toEqual(remoteProfile);
    expect(isRemoteLike(mode, override)).toBe(true);
  });
});

describe("cloneProfile", () => {
  it("copies optional credential fields", () => {
    const profile: HostProfile = {
      host: "example",
      user: "tester",
      auth: "key",
      key_path: "/id_ed25519",
      key_pass: "passphrase",
      password: "ignored",
    };
    const cloned = cloneProfile(profile);
    expect(cloned).not.toBe(profile);
    expect(cloned).toEqual(profile);

    cloned.key_path = "/other";
    cloned.key_pass = "new";
    cloned.password = "changed";
    expect(profile.key_path).toBe("/id_ed25519");
    expect(profile.key_pass).toBe("passphrase");
    expect(profile.password).toBe("ignored");
  });
});

describe("cache helpers", () => {
  it("builds scope keys with sensible defaults", () => {
    expect(scopeKeyForProfile(null)).toBe("local");
    expect(scopeKeyForProfile()).toBe("local");

    const remote: HostProfile = { host: "node", user: "ops" };
    expect(scopeKeyForProfile(remote)).toBe("remote:ops@node:22");

    const custom: HostProfile = { host: "node", user: "ops", port: 2224 };
    expect(scopeKeyForProfile(custom)).toBe("remote:ops@node:2224");
  });

  it("generates cache keys and renames entries", () => {
    const profile: HostProfile = { host: "node", user: "ops", port: 2200 };
    const cacheKey = sessionCacheKey("alpha", profile);
    expect(cacheKey).toBe("remote:ops@node:2200/alpha");

    const cache = new Map<string, TmuxWindow[]>();
    const scope = scopeKeyForProfile(profile);
    const initial: TmuxWindow[] = [
      { index: 0, id: "@1", name: "shell", active: true, panes: 1 },
    ];
    cache.set(sessionCacheKeyForScope(scope, "alpha"), initial);

    renameWindowsCacheEntry(cache, scope, "alpha", "beta");
    expect(cache.has(sessionCacheKeyForScope(scope, "alpha"))).toBe(false);
    expect(cache.get(sessionCacheKeyForScope(scope, "beta"))).toBe(initial);

    // renaming a non-existent entry is a no-op
    renameWindowsCacheEntry(cache, scope, "missing", "noop");
    expect(cache.size).toBe(1);
  });
});

describe("buildSendKeysControlCommand", () => {
  it("includes literal flag and enter when requested", () => {
    expect(buildSendKeysControlCommand("arc:0", "ls -la", true)).toBe(
      "send-keys -t arc:0 -l 'ls -la' Enter",
    );
  });

  it("omits enter when not requested", () => {
    expect(buildSendKeysControlCommand("local", "whoami", false)).toBe(
      "send-keys -t local -l whoami",
    );
  });

  it("escapes quotes and whitespace in the literal payload", () => {
    expect(buildSendKeysControlCommand("pane @1", "echo 'hi'", true)).toBe(
      "send-keys -t 'pane @1' -l 'echo '\"'\"'hi'\"'\"'' Enter",
    );
  });
});
