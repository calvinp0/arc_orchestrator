import { describe, expect, it } from "vitest";
import {
  cloneProfile,
  resolveEffectiveProfile,
  isRemoteLike,
  type HostProfile,
  type Mode,
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
