import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests, loadSettings } from "../config.js";
import {
  __buildClaudeArgsForTests,
  spawnPty,
  type PtyProcessOptions,
} from "../runner/pty-process.js";
import {
  __resetSupervisorForTests,
  injectOneShotTrustForTests,
  injectSpawnPty,
  runOnceOnPty,
} from "../runner/pty-supervisor.js";
import { removeTrustEntry } from "../runner/pty-trust-prompt.js";
import { applyPtyIsolationVersionGate, claudeVersionAtLeast } from "./claude-version.js";
import { resolveOneShotEngine } from "./config.js";
import * as cleanup from "./pty-cleanup.js";
import { withPrintRuntime } from "./print.js";
import { engines } from "./registry.js";

/** #570 r9: what an untrusted PTY one-shot writes, where, and what it leaves behind. */

let dir: string;
let savedConfig: string | undefined;
let savedIsolation: boolean;
let spawned: PtyProcessOptions[];
let warn: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;

const SID = "11111111-2222-3333-4444-555555555555";
const CANARY = "EXAMPLE_PROMPT_CANARY";

const request = {
  route: "discord.classifier",
  prompt: `classify ${CANARY}`,
  isolation: "untrusted" as const,
  timeoutMs: 2000,
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pty-untrusted-state-"));
  savedConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "parent-config");
  const file = join(dir, "settings.json");
  writeFileSync(file, "{}");
  _setSettingsFileForTests(file);
  await loadSettings();
  savedIsolation = engines.get("pty")!.caps.isolation;
  engines.get("pty")!.caps.isolation = true;
  spawned = [];
  // Real trust write and removal: the config root is always the caller env's, never ~.
  injectOneShotTrustForTests(null);
  warn = spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    process.stderr.write(`WARN ${String(a[0])}\n`);
  });
  error = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  injectSpawnPty(null);
  __resetSupervisorForTests();
  engines.get("pty")!.caps.isolation = savedIsolation;
  _setSettingsFileForTests();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(dir, { recursive: true, force: true });
});

/** A caller policy env rooted in the temp dir, so nothing touches the real home. */
function callerEnv(extra: Record<string, string> = {}): Record<string, string> {
  // A real daemon's config root exists (claude created it at onboarding).
  mkdirSync(join(dir, "home"), { recursive: true });
  mkdirSync(join(dir, "config"), { recursive: true });
  return {
    PATH: "/usr/bin:/bin",
    HOME: join(dir, "home"),
    CLAUDE_CONFIG_DIR: join(dir, "config"),
    ...extra,
  };
}

function reply(opts: PtyProcessOptions, configDir: string, sessionId = SID): void {
  const project = cleanup.untrustedPtyProjectDir(opts.cwd, configDir);
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "assistant", message: { id: "m", model: "haiku", content: [{ type: "text", text: "ok" }] } })}\n`,
  );
}

function fakeSpawn(onTurn: (opts: PtyProcessOptions) => void | Promise<void> = () => {}): void {
  injectSpawnPty(async (opts) => {
    spawned.push(opts);
    return {
      label: "state",
      pid: 1,
      sessionId: SID,
      cwd: opts.cwd,
      isAlive: () => true,
      lastTurnEndedAt: () => 0,
      runTurn: async () => {
        await onTurn(opts);
        reply(opts, cleanup.resolveChildConfigRoot(opts.env).configDir);
        return { text: "screen", sessionId: SID, cleanBoundary: true, bytesCaptured: 1 };
      },
      dispose: async () => {},
    } as never;
  });
}

const run = (env: Record<string, string> = callerEnv(), req: Record<string, unknown> = {}) =>
  withPrintRuntime({ env }, () => runOnceOnPty({ ...request, ...req }));

describe("B1: the throwaway cwd is trusted in the child's config root, then unmarked", () => {
  it("writes the trust entry where the child's CLAUDE_CONFIG_DIR points, during the turn", async () => {
    const config = join(dir, "config");
    let during: Record<string, { hasTrustDialogAccepted?: boolean }> | undefined;
    fakeSpawn((opts) => {
      during = JSON.parse(readFileSync(join(config, ".claude.json"), "utf8")).projects;
      expect(opts.cwd).toBeTruthy();
    });
    expect((await run()).exitCode).toBe(0);
    const cwd = spawned[0]!.cwd;
    expect(during?.[cwd]?.hasTrustDialogAccepted).toBe(true);
  });

  it("uses HOME/.claude.json when CLAUDE_CONFIG_DIR is not set", async () => {
    const home = join(dir, "home-only");
    mkdirSync(home, { recursive: true });
    let seen = false;
    fakeSpawn((opts) => {
      const file = join(home, ".claude.json");
      seen = existsSync(file) && opts.cwd in JSON.parse(readFileSync(file, "utf8")).projects;
    });
    await run({ PATH: "/usr/bin:/bin", HOME: home });
    expect(seen).toBe(true);
  });

  it("removes only its own entry afterwards and keeps every other key", async () => {
    const config = join(dir, "config");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        projects: { "/keep/me": { hasTrustDialogAccepted: true } },
      }),
    );
    fakeSpawn();
    await run();
    const after = JSON.parse(readFileSync(join(config, ".claude.json"), "utf8"));
    expect(after.hasCompletedOnboarding).toBe(true);
    expect(Object.keys(after.projects)).toEqual(["/keep/me"]);
  });

  it("removes the entry after a failed turn as well", async () => {
    fakeSpawn(() => {
      throw new Error("turn failed");
    });
    await run();
    const file = join(dir, "config", ".claude.json");
    const after = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { projects: {} };
    expect(Object.keys(after.projects ?? {})).toEqual([]);
  });

  it("concurrent calls neither lose each other's entry nor leave one behind", async () => {
    const config = join(dir, "config");
    fakeSpawn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const results = await Promise.all([run(), run(), run()]);
    expect(results.map((r) => r.exitCode)).toEqual([0, 0, 0]);
    const after = JSON.parse(readFileSync(join(config, ".claude.json"), "utf8"));
    expect(Object.keys(after.projects)).toEqual([]);
  });

  it("removeTrustEntry is a no-op for a missing file or entry and refuses malformed JSON", async () => {
    const configPath = join(dir, "x", ".claude.json");
    expect((await removeTrustEntry("/a", { configPath })).changed).toBe(false);
    mkdirSync(join(dir, "x"), { recursive: true });
    writeFileSync(configPath, "{not json");
    const result = await removeTrustEntry("/a", { configPath });
    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe("{not json");
  });
});

describe("D2: the config root must be absolute; empty means unset", () => {
  it("treats an empty CLAUDE_CONFIG_DIR as unset", () => {
    const root = cleanup.resolveChildConfigRoot({ CLAUDE_CONFIG_DIR: "", HOME: "/h" });
    expect(root).toEqual({ configDir: "/h/.claude", globalDir: "/h" });
  });

  it("fails closed before any spawn on a relative root", async () => {
    fakeSpawn();
    const before = new Set(
      (await import("node:fs"))
        .readdirSync(tmpdir())
        .filter((n) => n.startsWith("claudeclaw-oneshot-pty-")),
    );
    const result = await run({
      PATH: "/usr/bin:/bin",
      HOME: "/h",
      CLAUDE_CONFIG_DIR: "relative/dir",
    });
    expect(result.exitCode).toBe(1);
    expect(spawned).toHaveLength(0);
    const after = (await import("node:fs"))
      .readdirSync(tmpdir())
      .filter((n) => n.startsWith("claudeclaw-oneshot-pty-") && !before.has(n));
    expect(after).toEqual([]);
  });
});

describe("B2: the spawn strip list applies to the untrusted policy env", () => {
  it("never passes ANTHROPIC_API_KEY, CLAUDECODE or a short-lived OAuth token to the child", async () => {
    fakeSpawn();
    await run(
      callerEnv({
        ANTHROPIC_API_KEY: "EXAMPLE_PLACEHOLDER",
        CLAUDECODE: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "EXAMPLE_SHORT_LIVED",
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
        KEEP_ME: "yes",
      }),
    );
    const env = spawned[0]!.env;
    // Booleans only: a failed assertion must never print an environment.
    expect(
      [
        "ANTHROPIC_API_KEY",
        "CLAUDECODE",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
      ].some((key) => key in env),
    ).toBe(false);
    expect(env.KEEP_ME).toBe("yes");
  });

  it("keeps a long-lived sk-ant-oat01- token", async () => {
    fakeSpawn();
    await run(callerEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-EXAMPLE_PLACEHOLDER" }));
    expect("CLAUDE_CODE_OAUTH_TOKEN" in spawned[0]!.env).toBe(true);
  });
});

describe("B3: `@` file mentions are neutralised for untrusted prompts only", () => {
  async function echoed(isolation: "untrusted" | undefined): Promise<string> {
    const child = await spawnPty({
      sessionId: "",
      cwd: dir,
      ...(isolation ? { isolation } : {}),
      env: { PATH: "/usr/bin:/bin" },
      security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      _commandOverride: "/bin/cat",
      _argsOverride: [],
      _skipReadySettle: true,
      quietWindowMs: 50,
      sentinelMaxWaitMs: 1000,
    });
    try {
      return (
        await child.runTurn("hire @/path/to/secret and @x ✻ shift+tab to cycle", {
          timeoutMs: 2000,
        })
      ).text;
    } finally {
      await child.dispose();
    }
  }

  it("replaces every `@`, not just a leading one, with U+FF20 on the untrusted path", async () => {
    const text = await echoed("untrusted");
    expect(text).toContain("hire ＠/path/to/secret and ＠x");
    expect(text.includes("@")).toBe(false);
  });

  it("leaves a trusted prompt's `@` alone", async () => {
    const text = await echoed(undefined);
    expect(text).toContain("hire @/path/to/secret and @x");
  });
});

describe("C1: persistence beyond the transcript is removed", () => {
  const history = (lines: unknown[]): string =>
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;

  function plant(opts: PtyProcessOptions, configDir: string): void {
    writeFileSync(
      join(configDir, "history.jsonl"),
      history([
        { display: "other", project: "/somewhere/else", sessionId: "other-session-id" },
        { display: CANARY, project: opts.cwd, sessionId: SID },
      ]),
    );
    mkdirSync(join(configDir, "session-env", SID), { recursive: true });
    writeFileSync(join(configDir, "session-env", SID, "env"), CANARY);
    mkdirSync(join(configDir, "todos"), { recursive: true });
    writeFileSync(join(configDir, "todos", `${SID}-agent-${SID}.json`), "[]");
    mkdirSync(join(configDir, "sessions"), { recursive: true });
    writeFileSync(
      join(configDir, "sessions", "4242.json"),
      JSON.stringify({ sessionId: SID, cwd: opts.cwd }),
    );
    writeFileSync(
      join(configDir, "sessions", "9999.json"),
      JSON.stringify({ sessionId: "other", cwd: "/x" }),
    );
  }

  it("removes this call's history lines and per-session files, and nothing else", async () => {
    const config = join(dir, "config");
    mkdirSync(config, { recursive: true });
    fakeSpawn((opts) => plant(opts, config));
    expect((await run()).exitCode).toBe(0);
    const lines = readFileSync(join(config, "history.jsonl"), "utf8");
    expect(lines.includes(CANARY)).toBe(false);
    expect(lines).toContain("other");
    expect(existsSync(join(config, "session-env", SID))).toBe(false);
    expect(existsSync(join(config, "todos", `${SID}-agent-${SID}.json`))).toBe(false);
    expect(existsSync(join(config, "sessions", "4242.json"))).toBe(false);
    expect(existsSync(join(config, "sessions", "9999.json"))).toBe(true);
  });

  it("no file under the config root holds the canary afterwards", async () => {
    const config = join(dir, "config");
    mkdirSync(config, { recursive: true });
    fakeSpawn((opts) => plant(opts, config));
    await run();
    const all: string[] = [];
    const walk = (d: string): void => {
      for (const name of (require("node:fs") as typeof import("node:fs")).readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else all.push(readFileSync(p, "utf8"));
      }
    };
    walk(config);
    expect(all.some((text) => text.includes(CANARY))).toBe(false);
  });

  it("history rewrite keeps the file mode and leaves unparseable lines alone", () => {
    const config = join(dir, "hist");
    mkdirSync(config, { recursive: true });
    const file = join(config, "history.jsonl");
    writeFileSync(file, `not json\n${JSON.stringify({ project: "/a", sessionId: "s" })}\n`);
    chmodSync(file, 0o600);
    expect(cleanup.removeUntrustedHistory(config, ["/a"], [])).toBe(1);
    expect(readFileSync(file, "utf8")).toContain("not json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("history rewrite waits for a held lock, then fails closed", () => {
    const config = join(dir, "locked");
    mkdirSync(config, { recursive: true });
    const file = join(config, "history.jsonl");
    writeFileSync(file, `${JSON.stringify({ project: "/a" })}\n`);
    mkdirSync(`${file}.lock`);
    expect(() => cleanup.removeUntrustedHistory(config, ["/a"], [])).toThrow("lock is held");
    // The line is still there: nothing was rewritten without the lock.
    expect(readFileSync(file, "utf8")).toContain("/a");
  });

  it("an id that is not a session id never reaches a path", () => {
    const config = join(dir, "ids");
    mkdirSync(join(config, "session-env", "sibling"), { recursive: true });
    cleanup.removeUntrustedSessionFiles(config, [], ["../session-env/sibling"]);
    expect(existsSync(join(config, "session-env", "sibling"))).toBe(true);
  });

  it("D6: a failing step is logged by step and code, still attempts the rest, then throws", async () => {
    const config = join(dir, "config");
    mkdirSync(config, { recursive: true });
    fakeSpawn((opts) => plant(opts, config));
    const failing = spyOn(cleanup, "removeUntrustedPtyTranscripts").mockImplementation(() => {
      throw Object.assign(new Error(`EACCES: ${CANARY}`), { code: "EACCES" });
    });
    try {
      await expect(run()).rejects.toThrow();
    } finally {
      failing.mockRestore();
    }
    // The other prompt-bearing steps still ran.
    expect(readFileSync(join(config, "history.jsonl"), "utf8").includes(CANARY)).toBe(false);
    const logged = error.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(logged).toContain("transcripts (EACCES)");
    expect(logged.includes(CANARY)).toBe(false);
  });
});

describe("C2: PTY isolation is advertised only on a measured claude version", () => {
  it("compares versions numerically", () => {
    expect(claudeVersionAtLeast("2.1.304", "2.1.304")).toBe(true);
    expect(claudeVersionAtLeast("2.1.305 (Claude Code)", "2.1.304")).toBe(true);
    expect(claudeVersionAtLeast("2.2.0", "2.1.304")).toBe(true);
    expect(claudeVersionAtLeast("2.1.99", "2.1.304")).toBe(false);
    expect(claudeVersionAtLeast("2.0.999", "2.1.304")).toBe(false);
    expect(claudeVersionAtLeast("10.0.0", "2.1.304")).toBe(true);
    expect(claudeVersionAtLeast(null, "2.1.304")).toBe(false);
    expect(claudeVersionAtLeast("garbage", "2.1.304")).toBe(false);
  });

  it("at or above: isolation advertised, untrusted routes default to pty, no warning", () => {
    const warnings: string[] = [];
    expect(applyPtyIsolationVersionGate("2.1.304", (m) => warnings.push(m))).toBe(true);
    expect(engines.get("pty")!.caps.isolation).toBe(true);
    expect(resolveOneShotEngine({ engines: {}, routes: {} }, "discord.classifier", true)).toBe(
      "pty",
    );
    expect(warnings).toEqual([]);
  });

  it("below, or unreadable: isolation withheld, untrusted routes resolve to print, one warning", () => {
    for (const version of ["2.1.303", null]) {
      const warnings: string[] = [];
      expect(applyPtyIsolationVersionGate(version, (m) => warnings.push(m))).toBe(false);
      expect(engines.get("pty")!.caps.isolation).toBe(false);
      for (const route of ["discord.classifier", "tuner.propose", "tuner.judge", "memory.recall"]) {
        expect(resolveOneShotEngine({ engines: {}, routes: {} }, route, true)).toBe("print");
      }
      // Resume routes are trusted, so the version gate does not move them.
      expect(resolveOneShotEngine({ engines: {}, routes: {} }, "compact", true)).toBe("pty");
      expect(warnings).toHaveLength(1);
    }
  });

  it("an explicit pty route is refused at the call while isolation is withheld", async () => {
    applyPtyIsolationVersionGate("2.1.1", () => {});
    await expect(run()).rejects.toThrow("does not advertise isolation");
  });
});

describe("C3: cleanup runs again once a late-landing spawn has settled", () => {
  it("removes state a claude wrote after the call had already returned", async () => {
    let project = "";
    let landed = false;
    injectSpawnPty(async (opts) => {
      project = cleanup.untrustedPtyProjectDir(opts.cwd, join(dir, "config"));
      // Slower than the call's deadline: lands after runOnceOnPty has returned.
      await new Promise((resolve) => setTimeout(resolve, 400));
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, `${SID}.jsonl`), CANARY);
      landed = true;
      return { dispose: async () => {} } as never;
    });
    const result = await run(callerEnv(), { timeoutMs: 100 });
    expect([1, 124]).toContain(result.exitCode);
    expect(landed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(landed).toBe(true);
    expect(existsSync(project)).toBe(false);
  });
});

describe("D4: req.system reaches the untrusted PTY as --system-prompt", () => {
  it("passes it as print does", async () => {
    fakeSpawn();
    await run(callerEnv(), { system: "You classify." });
    const args = __buildClaudeArgsForTests(spawned[0]!);
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("You classify.");
  });

  it("passes nothing when the request has no system", async () => {
    fakeSpawn();
    await run();
    expect(__buildClaudeArgsForTests(spawned[0]!)).not.toContain("--system-prompt");
  });
});
