import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { _setSettingsFileForTests, loadSettings } from "../config.js";
import {
  __buildClaudeArgsForTests,
  spawnPty,
  type PtyProcessOptions,
} from "../runner/pty-process.js";
import { setUntrustedFileMentionNeutralizingForTests } from "../runner/pty-process-test-seams.js";
import { neutralizeFileMentions } from "../runner/pty-prompt-sanitizer.js";
import {
  __resetSupervisorForTests,
  injectOneShotTrustForTests,
  injectSpawnPty,
  runOnceOnPty,
} from "../runner/pty-supervisor.js";
import { applyPtyIsolationVersionGate, claudeVersionAtLeast } from "./claude-version.js";
import { resolveOneShotEngine } from "./config.js";
import * as cleanup from "./pty-cleanup.js";
import { withPrintRuntime } from "./print.js";
import { engines } from "./registry.js";

/** #570 r11: what an untrusted PTY one-shot writes, where, and what it leaves behind. */

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

/** What the child's claude writes: a transcript under ITS config root (the throwaway one). */
function reply(opts: PtyProcessOptions, sessionId = SID, text = "ok"): void {
  const project = cleanup.untrustedPtyProjectDir(opts.cwd, opts.env.CLAUDE_CONFIG_DIR!);
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "assistant", message: { id: "m", model: "haiku", content: [{ type: "text", text }] } })}\n`,
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
        reply(opts);
        return { text: "screen", sessionId: SID, cleanBoundary: true, bytesCaptured: 1 };
      },
      dispose: async () => {},
    } as never;
  });
}

const run = (env: Record<string, string> = callerEnv(), req: Record<string, unknown> = {}) =>
  withPrintRuntime({ env }, () => runOnceOnPty({ ...request, ...req }));

/** path, size and sha256 of every file and directory under `root`: a full byte snapshot. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const rel = relative(root, path);
      if (statSync(path).isDirectory()) {
        out.push(`${rel}/`);
        walk(path);
      } else {
        const bytes = readFileSync(path);
        out.push(`${rel}:${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
  };
  walk(root);
  return out;
}

const oneShotTempDirs = (prefix: string): string[] =>
  readdirSync(tmpdir()).filter((name) => name.startsWith(prefix));

describe("A: each untrusted call gets its own throwaway config root", () => {
  it("is a 0700 sibling of the temp cwd, seeded with onboarding and trust for both cwd forms", async () => {
    // Went red alone when the seed was written without hasTrustDialogAccepted.
    let mode = 0;
    let seeded: Record<string, any> = {};
    let fileMode = 0;
    let forms: string[] = [];
    fakeSpawn((opts) => {
      forms = [opts.cwd, realpathSync(opts.cwd)];
      const root = opts.env.CLAUDE_CONFIG_DIR!;
      mode = statSync(root).mode & 0o777;
      fileMode = statSync(join(root, ".claude.json")).mode & 0o777;
      seeded = JSON.parse(readFileSync(join(root, ".claude.json"), "utf8"));
    });
    expect((await run()).exitCode).toBe(0);
    const env = spawned[0]!.env;
    expect(env.CLAUDE_CONFIG_DIR!.startsWith(join(tmpdir(), "claudeclaw-oneshot-cfg-"))).toBe(true);
    expect(env.CLAUDE_CONFIG_DIR === join(dir, "config")).toBe(false);
    expect(mode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    expect(seeded.hasCompletedOnboarding).toBe(true);
    expect(forms.length).toBeGreaterThan(0);
    for (const cwd of forms) expect(seeded.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
    // HOME is the caller's, untouched: only the config location moves.
    expect(env.HOME).toBe(join(dir, "home"));
  });

  it("two calls get two different roots", async () => {
    fakeSpawn();
    await run();
    await run();
    expect(spawned[0]!.env.CLAUDE_CONFIG_DIR).not.toBe(spawned[1]!.env.CLAUDE_CONFIG_DIR);
  });

  it("keeps the operator's login: credentials are read from the operator's config dir", async () => {
    // Went red (with the env-policy test in pty-isolation.test.ts) when CLAUDE_SECURESTORAGE_CONFIG_DIR was not set.
    fakeSpawn();
    await run();
    expect(spawned[0]!.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(join(dir, "config"));
  });

  it('uses "" (the default store) when the operator has no CLAUDE_CONFIG_DIR, empty counts as unset', async () => {
    delete process.env.CLAUDE_CONFIG_DIR; // the daemon has none either; afterEach restores it
    fakeSpawn();
    await run({ PATH: "/usr/bin:/bin", HOME: join(dir, "home") });
    await run({ PATH: "/usr/bin:/bin", HOME: join(dir, "home"), CLAUDE_CONFIG_DIR: "" });
    expect(spawned[0]!.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
    expect(spawned[1]!.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
  });

  it("passes an explicit CLAUDE_SECURESTORAGE_CONFIG_DIR through as given", async () => {
    // Went red when the caller's explicit value was ignored in favour of CLAUDE_CONFIG_DIR.
    fakeSpawn();
    await run(callerEnv({ CLAUDE_SECURESTORAGE_CONFIG_DIR: join(dir, "store") }));
    await run(callerEnv({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "" }));
    expect(spawned[0]!.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(join(dir, "store"));
    expect(spawned[1]!.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("");
  });
});

describe("A: nothing on the untrusted path writes under the operator's config root", () => {
  /** Plant a fake operator root and HOME with the files a real login would have. */
  function operatorFiles(): { config: string; home: string } {
    const env = callerEnv();
    const config = env.CLAUDE_CONFIG_DIR!;
    const home = env.HOME!;
    writeFileSync(join(config, ".credentials.json"), "{}", { mode: 0o600 });
    writeFileSync(
      join(config, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true, projects: { "/keep/me": {} } }),
    );
    writeFileSync(join(config, "history.jsonl"), `${JSON.stringify({ display: "mine" })}\n`);
    mkdirSync(join(config, "projects", "-keep"), { recursive: true });
    writeFileSync(join(config, "projects", "-keep", "a.jsonl"), "{}\n");
    writeFileSync(join(home, ".claude.json"), "{}");
    return { config, home };
  }

  /** What claude writes about a call, all of it under ITS config root. */
  const writeLikeClaude = (opts: PtyProcessOptions): void => {
    const root = opts.env.CLAUDE_CONFIG_DIR!;
    writeFileSync(join(root, "history.jsonl"), `${JSON.stringify({ display: CANARY })}\n`);
    mkdirSync(join(root, "paste-cache"), { recursive: true });
    writeFileSync(join(root, "paste-cache", "p.txt"), CANARY);
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(root, "sessions", "1.json"), CANARY);
  };

  for (const [label, turn] of [
    ["a successful turn", (): void => {}],
    [
      "a failed turn",
      (): void => {
        throw new Error("turn failed");
      },
    ],
  ] as const) {
    it(`leaves the operator's root and HOME byte-identical after ${label}`, async () => {
      // Went red (14 failures across the file) when the child kept the operator's CLAUDE_CONFIG_DIR.
      const { config, home } = operatorFiles();
      const before = { config: snapshot(config), home: snapshot(home) };
      let wroteInRoot = false;
      fakeSpawn((opts) => {
        writeLikeClaude(opts);
        wroteInRoot =
          readFileSync(join(opts.env.CLAUDE_CONFIG_DIR!, "paste-cache", "p.txt"), "utf8") ===
          CANARY;
        turn();
      });
      await run();
      // The fake did write the prompt somewhere: the root it was given, not the operator's.
      expect(wroteInRoot).toBe(true);
      expect(snapshot(config)).toEqual(before.config);
      expect(snapshot(home)).toEqual(before.home);
    });
  }
});

describe("A: the root and the cwd are removed whatever the turn did", () => {
  const gone = (opts: PtyProcessOptions): boolean =>
    !existsSync(opts.env.CLAUDE_CONFIG_DIR!) && !existsSync(opts.cwd);

  it("after a successful turn, with the prompt canary written into it", async () => {
    // Went red when the root removal was a no-op.
    fakeSpawn((opts) => {
      mkdirSync(join(opts.env.CLAUDE_CONFIG_DIR!, "paste-cache"), { recursive: true });
      writeFileSync(join(opts.env.CLAUDE_CONFIG_DIR!, "paste-cache", "p.txt"), CANARY);
    });
    expect((await run()).exitCode).toBe(0);
    expect(gone(spawned[0]!)).toBe(true);
  });

  it("after a failed turn", async () => {
    fakeSpawn(() => {
      throw new Error("turn failed");
    });
    await run();
    expect(gone(spawned[0]!)).toBe(true);
  });

  it("after a spawn that throws", async () => {
    let seen: PtyProcessOptions | undefined;
    injectSpawnPty(async (opts) => {
      seen = opts;
      throw new Error("spawn failed");
    });
    await run();
    expect(seen).toBeDefined();
    expect(gone(seen!)).toBe(true);
  });
});

describe("A: removal proves the root stays gone", () => {
  it("removes a root a dying writer re-creates during the quiet wait", async () => {
    const root = mkdtempSync(join(dir, "reappear-"));
    writeFileSync(join(root, "f"), CANARY);
    let sleeps = 0;
    await cleanup.removeUntrustedConfigRoot(root, {
      quietMs: 1,
      sleep: async () => {
        // The first quiet wait sees a late write that brings the directory back.
        if (sleeps++ === 0) {
          mkdirSync(root, { recursive: true });
          writeFileSync(join(root, "late"), CANARY);
        }
      },
    });
    expect(sleeps).toBe(2);
    expect(existsSync(root)).toBe(false);
  });

  it("gives up, and throws, when the root never stays gone", async () => {
    const root = mkdtempSync(join(dir, "never-"));
    let sleeps = 0;
    await expect(
      cleanup.removeUntrustedConfigRoot(root, {
        quietMs: 1,
        maxPasses: 3,
        sleep: async () => {
          sleeps++;
          mkdirSync(root, { recursive: true });
        },
      }),
    ).rejects.toThrow("kept reappearing");
    expect(sleeps).toBe(3);
  });

  it("the child is told not to clone the official plugin marketplace into a fresh root", async () => {
    fakeSpawn();
    await run();
    expect(spawned[0]!.env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL).toBe("1");
  });
});

describe("A: fail closed", () => {
  it("a root that cannot be created fails the call before any spawn and leaves nothing", async () => {
    // Went red when the temp cwd was left behind after the failed create.
    fakeSpawn();
    const before = oneShotTempDirs("claudeclaw-oneshot-pty-");
    const failing = spyOn(cleanup, "createUntrustedConfigRoot").mockImplementation(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    try {
      expect((await run()).exitCode).toBe(1);
    } finally {
      failing.mockRestore();
    }
    expect(spawned).toHaveLength(0);
    expect(oneShotTempDirs("claudeclaw-oneshot-pty-")).toEqual(before);
  });

  it("D6: a root that cannot be removed is logged by step and code, and the call throws", async () => {
    // Went red when the removal error was swallowed instead of thrown.
    fakeSpawn((opts) => writeFileSync(join(opts.env.CLAUDE_CONFIG_DIR!, "history.jsonl"), CANARY));
    const failing = spyOn(cleanup, "removeUntrustedConfigRoot").mockImplementation(() => {
      throw Object.assign(new Error(`EACCES: ${CANARY}`), { code: "EACCES" });
    });
    try {
      await expect(run()).rejects.toThrow();
    } finally {
      failing.mockRestore();
      rmSync(spawned[0]!.env.CLAUDE_CONFIG_DIR!, { recursive: true, force: true });
    }
    const logged = error.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
    expect(logged).toContain("config root (EACCES)");
    expect(logged.includes(CANARY)).toBe(false);
  });
});

describe("A: startup sweep of leftovers", () => {
  const MIN = 60_000;
  const NOW = 1_800_000_000_000;
  const age = (path: string, minutes: number): void => {
    const when = new Date(NOW - minutes * MIN);
    utimesSync(path, when, when);
  };

  it("removes oneshot dirs older than 10 minutes, and only those", () => {
    // Went red when the age test was dropped (fresh dirs removed) and when non-directories (file, symlink) were removed.
    const base = mkdtempSync(join(dir, "sweep-"));
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "x");
    const mk = (name: string, minutes: number): void => {
      mkdirSync(join(base, name));
      writeFileSync(join(base, name, "f"), CANARY);
      age(join(base, name), minutes);
    };
    mk("claudeclaw-oneshot-cfg-old", 10.1);
    mk("claudeclaw-oneshot-pty-old", 11);
    mk("claudeclaw-oneshot-cfg-fresh", 9.9);
    mk("claudeclaw-oneshot-pty-fresh", 1);
    mk("claudeclaw-oneshot-unrelated-old", 60);
    mk("other-old", 60);
    writeFileSync(join(base, "claudeclaw-oneshot-cfg-file"), "x");
    age(join(base, "claudeclaw-oneshot-cfg-file"), 60);
    symlinkSync(outside, join(base, "claudeclaw-oneshot-pty-link"));

    expect(cleanup.sweepStaleOneShotDirs(base, NOW)).toBe(2);
    expect(readdirSync(base).sort()).toEqual([
      "claudeclaw-oneshot-cfg-file",
      "claudeclaw-oneshot-cfg-fresh",
      "claudeclaw-oneshot-pty-fresh",
      "claudeclaw-oneshot-pty-link",
      "claudeclaw-oneshot-unrelated-old",
      "other-old",
    ]);
    // A symlink with the prefix is left alone and never followed.
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  it("a missing directory is not an error", () => {
    expect(cleanup.sweepStaleOneShotDirs(join(dir, "nope"), NOW)).toBe(0);
  });

  it("the daemon runs it at start, before the version probe", () => {
    // Went red when start.ts stopped calling the sweep.
    const start = readFileSync(join(import.meta.dir, "../commands/start.ts"), "utf8");
    const sweep = start.indexOf("startOneShotSweeper()");
    expect(sweep).toBeGreaterThan(0);
    expect(sweep).toBeLessThan(start.indexOf("probeClaudeCliVersion()"));
  });
});

describe("r12 F2: the operator's config dir comes from the daemon when print's policy env lacks it", () => {
  it("an operator with a custom CLAUDE_CONFIG_DIR keeps that credential store", async () => {
    fakeSpawn();
    // beforeEach put the operator's config dir in the daemon env; the policy env names none.
    await run({ PATH: "/usr/bin:/bin", HOME: join(dir, "home") });
    expect(spawned[0]!.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(join(dir, "parent-config"));
    // Not the throwaway root, and the child's own config dir is still the throwaway one.
    expect(spawned[0]!.env.CLAUDE_CONFIG_DIR).not.toBe(join(dir, "parent-config"));
  });
});

describe("r12 B: a running call's directories are owned, registered and not swept", () => {
  it("registers them for the call and releases them when it ends, however it ends", async () => {
    const registered = cleanup.activeOneShotDirCount();
    let during = 0;
    fakeSpawn(() => {
      during = cleanup.activeOneShotDirCount();
    });
    await run();
    expect(during).toBe(registered + 2);
    expect(cleanup.activeOneShotDirCount()).toBe(registered);
    injectSpawnPty(async () => {
      throw new Error("spawn refused");
    });
    await run();
    expect(cleanup.activeOneShotDirCount()).toBe(registered);
  });

  it("writes the owner file into the root and the cwd, and a sweep during the turn keeps both", async () => {
    let during: { root: boolean; cwd: boolean; owners: boolean } | undefined;
    fakeSpawn((opts) => {
      const root = opts.env.CLAUDE_CONFIG_DIR!;
      const owned = (p: string): boolean => existsSync(join(p, cleanup.ONESHOT_OWNER_FILE));
      const old = new Date(Date.now() - 60 * 60_000);
      utimesSync(root, old, old);
      utimesSync(opts.cwd, old, old);
      cleanup.sweepStaleOneShotDirs(tmpdir(), Date.now());
      during = {
        root: existsSync(root),
        cwd: existsSync(opts.cwd),
        owners: owned(root) && owned(opts.cwd),
      };
    });
    expect((await run()).exitCode).toBe(0);
    expect(during).toEqual({ root: true, cwd: true, owners: true });
  });
});

describe("r12 A: a process group that outlives retirement fails the call and keeps the root", () => {
  it("throws, logs the pid, and leaves the root for the sweep (nothing may still be writing into a removed dir)", async () => {
    fakeSpawn();
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
          reply(opts);
          return { text: "screen", sessionId: SID, cleanBoundary: true, bytesCaptured: 1 };
        },
        dispose: async () => opts.onGroupSurvived?.(424242),
      } as never;
    });
    const registered = cleanup.activeOneShotDirCount();
    await expect(run()).rejects.toThrow(/survived retirement/);
    const root = spawned[0]!.env.CLAUDE_CONFIG_DIR!;
    try {
      expect(cleanup.activeOneShotDirCount()).toBe(registered);
      expect(existsSync(root)).toBe(true);
      const logged = error.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
      expect(logged).toContain("pid 424242");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("r12 E: a spawn refused for want of a ready REPL fails the call with nothing sent", () => {
  it("returns exit 1 with no reply and leaves no directory behind", async () => {
    const before = oneShotTempDirs("claudeclaw-oneshot-");
    injectSpawnPty(async () => {
      throw new Error("untrusted PTY not ready (login-required); nothing was sent");
    });
    const result = await run();
    expect(result.exitCode).toBe(1);
    expect(result.text).toBe("");
    expect(oneShotTempDirs("claudeclaw-oneshot-")).toEqual(before);
  });
});

describe("r12 F1: a failure while building the call's state leaks nothing", () => {
  it("removes the temp cwd and the config root when the project dir cannot be resolved", async () => {
    fakeSpawn();
    const before = oneShotTempDirs("claudeclaw-oneshot-");
    const failing = spyOn(cleanup, "untrustedPtyProjectDir").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    try {
      await expect(run()).rejects.toThrow("ENOENT");
    } finally {
      failing.mockRestore();
    }
    expect(spawned).toHaveLength(0);
    expect(oneShotTempDirs("claudeclaw-oneshot-")).toEqual(before);
  });
});

describe("D2: the credential directory must be absolute; empty means unset", () => {
  it("fails closed before any spawn on a relative root", async () => {
    fakeSpawn();
    const before = oneShotTempDirs("claudeclaw-oneshot-");
    for (const env of [
      { PATH: "/usr/bin:/bin", HOME: "/h", CLAUDE_CONFIG_DIR: "relative/dir" },
      { PATH: "/usr/bin:/bin", HOME: "/h", CLAUDE_SECURESTORAGE_CONFIG_DIR: "relative/store" },
    ]) {
      expect((await run(env)).exitCode).toBe(1);
    }
    expect(spawned).toHaveLength(0);
    expect(oneShotTempDirs("claudeclaw-oneshot-")).toEqual(before);
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
  it("removes the root a claude wrote into after the call had already returned", async () => {
    // Went red when the second pass after lateRetire was a no-op.
    let root = "";
    let landed = false;
    const registered = cleanup.activeOneShotDirCount();
    injectSpawnPty(async (opts) => {
      root = opts.env.CLAUDE_CONFIG_DIR!;
      const project = cleanup.untrustedPtyProjectDir(opts.cwd, root);
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
    // The call has returned but the late claude has not landed: both dirs are still a live call's.
    expect(cleanup.activeOneShotDirCount()).toBe(registered + 2);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(landed).toBe(true);
    expect(existsSync(root)).toBe(false);
    expect(cleanup.activeOneShotDirCount()).toBe(registered);
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

describe("B3 (print): `claude -p` expands @ mentions too, so the same replacement applies", () => {
  async function stdinFor(isolation: "untrusted" | "trusted-session"): Promise<string> {
    let input = "";
    const spawnFn = (() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: Object.assign(new EventEmitter(), {
          end: (text: string) => {
            input = text;
          },
        }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("ok"));
        child.emit("close", 0);
      });
      return child;
    }) as never;
    await withPrintRuntime({ spawn: spawnFn, env: callerEnv(), stdinPrompt: true }, () =>
      engines.get("print")!.run({
        route: isolation === "untrusted" ? "discord.classifier" : "compact",
        isolation,
        prompt: "hire @/path/to/secret and @x",
        timeoutMs: 1000,
      }),
    );
    return input;
  }

  it("replaces every @ in an untrusted print prompt", async () => {
    expect(await stdinFor("untrusted")).toBe("hire \uff20/path/to/secret and \uff20x");
  });

  it("leaves a trusted print prompt alone", async () => {
    expect(await stdinFor("trusted-session")).toBe("hire @/path/to/secret and @x");
  });

  it("the shared test seam switches it off", async () => {
    setUntrustedFileMentionNeutralizingForTests(false);
    try {
      expect(await stdinFor("untrusted")).toContain("@/path/to/secret");
    } finally {
      setUntrustedFileMentionNeutralizingForTests(true);
    }
  });
});

describe("C: the reply gets its `@` back, on both engines, in one place", () => {
  // A tuner-shaped prompt: a skill file with a scoped package, an e-mail and a decorator.
  const SKILL = "use @anthropic-ai/sdk, write to me@example.com, mark it @decorator";

  it("pty: a model that echoes the neutralised prompt returns the original text", async () => {
    // Went red when the pty engine did not map U+FF20 back; the print and trusted-reply tests below went red for their own sites.
    let modelSaw = "";
    injectSpawnPty(async (opts) => {
      spawned.push(opts);
      return {
        label: "state",
        pid: 1,
        sessionId: SID,
        cwd: opts.cwd,
        isAlive: () => true,
        lastTurnEndedAt: () => 0,
        runTurn: async (prompt: string) => {
          // The real process writes the prompt through this same helper.
          modelSaw = neutralizeFileMentions(prompt);
          reply(opts, SID, modelSaw);
          return { text: "screen", sessionId: SID, cleanBoundary: true, bytesCaptured: 1 };
        },
        dispose: async () => {},
      } as never;
    });
    const result = await withPrintRuntime({ env: callerEnv() }, () =>
      engines
        .get("pty")!
        .run({ route: "tuner.propose", prompt: SKILL, isolation: "untrusted", timeoutMs: 2000 }),
    );
    // Not vacuous: the model really was handed fullwidth characters.
    expect(modelSaw.includes("\uff20")).toBe(true);
    expect(result.text).toBe(SKILL);
  });

  async function printEcho(
    isolation: "untrusted" | "trusted-session",
    output?: string,
  ): Promise<string> {
    const spawnFn = (() => {
      let input = "";
      const child = Object.assign(new EventEmitter(), {
        stdin: Object.assign(new EventEmitter(), {
          end: (text: string) => {
            input = text;
          },
        }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(output ?? input));
        child.emit("close", 0);
      });
      return child;
    }) as never;
    const result = await withPrintRuntime(
      { spawn: spawnFn, env: callerEnv(), stdinPrompt: true },
      () =>
        engines.get("print")!.run({
          route: isolation === "untrusted" ? "tuner.propose" : "compact",
          isolation,
          prompt: SKILL,
          timeoutMs: 1000,
        }),
    );
    return result.text;
  }

  it("print: the echoed prompt comes back with its @", async () => {
    expect(await printEcho("untrusted")).toBe(SKILL);
  });

  it("a trusted call's reply is left exactly as the model wrote it", async () => {
    expect(await printEcho("trusted-session", "a\uff20b")).toBe("a\uff20b");
  });
});
