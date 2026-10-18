/** #548: `settings.oneShot` is checked at load, so a bad mapping never reaches a call. */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests, reloadSettings } from "../../config";
import {
  BUILTIN_ENGINES,
  DEFAULT_ONESHOT_SETTINGS,
  type OneShotEngine,
  PTY_UNTRUSTED_VERIFIED,
  parseOneShotSettings,
} from "..";

describe("parseOneShotSettings", () => {
  it("absent block: every route on print", () => {
    expect(parseOneShotSettings(undefined)).toEqual(DEFAULT_ONESHOT_SETTINGS);
    expect(DEFAULT_ONESHOT_SETTINGS.default).toBe("print");
  });

  it("a resume route on an engine without caps.resume fails at load", () => {
    const noResume: OneShotEngine = {
      id: "nr",
      caps: { resume: false, tools: false, isolation: true },
      run: async () => ({ text: "", exitCode: 0, stderr: "" }),
    };
    const builtins = { ...BUILTIN_ENGINES, nr: noResume };
    expect(() => parseOneShotSettings({ routes: { compact: "nr" } }, builtins)).toThrow(
      /route compact resumes a session; engine nr cannot/,
    );
    // The default reaches every unlisted route, resume routes included.
    expect(() => parseOneShotSettings({ default: "nr" }, builtins)).toThrow(/resumes a session/);
    // Untrusted routes do not resume: nr may take them.
    expect(parseOneShotSettings({ routes: { "tuner.judge": "nr" } }, builtins).routes).toEqual({
      "tuner.judge": "nr",
    });
  });

  it("an untrusted route on pty fails while the spike flag is off", () => {
    expect(PTY_UNTRUSTED_VERIFIED).toBe(false);
    expect(() => parseOneShotSettings({ routes: { "discord.classifier": "pty" } })).toThrow(
      /route discord\.classifier reads untrusted text; engine pty cannot/,
    );
    expect(() => parseOneShotSettings({ default: "pty" })).toThrow(/reads untrusted text/);
    // Through an alias too.
    expect(() =>
      parseOneShotSettings({
        engines: { live: { type: "pty" } },
        routes: { "tuner.propose": "live" },
      }),
    ).toThrow(/engine live cannot run it isolated/);
  });

  it("trusted routes may use pty", () => {
    const s = parseOneShotSettings({
      routes: { compact: "pty", "rotation.summary": "pty", "memory.save.stop": "pty" },
    });
    expect(s.routes.compact).toBe("pty");
    expect(s.default).toBe("print");
  });

  it("refuses unknown routes, engines and types, and a redefined built-in", () => {
    expect(() => parseOneShotSettings({ routes: { "no.such": "print" } })).toThrow(/unknown route/);
    expect(() => parseOneShotSettings({ routes: { compact: "nope" } })).toThrow(/unknown engine/);
    expect(() => parseOneShotSettings({ default: "nope" })).toThrow(/unknown engine/);
    expect(() => parseOneShotSettings({ engines: { x: { type: "http" } } })).toThrow(/type must/);
    expect(() => parseOneShotSettings({ engines: { print: { type: "pty" } } })).toThrow(
      /redefines a built-in/,
    );
    expect(() => parseOneShotSettings("print")).toThrow(/must be an object/);
  });

  it("inherited object keys are not engines or routes", () => {
    for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(() => parseOneShotSettings({ default: k })).toThrow(/unknown engine/);
      expect(() => parseOneShotSettings({ engines: { x: { type: k } } })).toThrow(/type must/);
      expect(() => parseOneShotSettings({ routes: { [k]: "print" } })).toThrow(/unknown route/);
    }
  });
});

describe("settings.json load", () => {
  let dir = "";
  afterEach(() => {
    _setSettingsFileForTests();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function load(oneShot: unknown) {
    dir = mkdtempSync(join(tmpdir(), "oneshot-settings-"));
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ oneShot }));
    _setSettingsFileForTests(file);
    return reloadSettings();
  }

  it("carries the parsed block", async () => {
    const s = await load({ routes: { compact: "pty" } });
    expect(s.oneShot.routes).toEqual({ compact: "pty" });
  });

  it("fails the load on a mapping it cannot honour", async () => {
    await expect(load({ routes: { "tuner.judge": "pty" } })).rejects.toThrow(/reads untrusted/);
  });
});
