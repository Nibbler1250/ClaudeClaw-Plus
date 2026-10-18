/**
 * #548: one-shot calls go through `runOneShot`, and every engine applies the
 * one isolation rule. The contract tests loop over the engine registry, so an
 * engine added later is held to them by default.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { __buildClaudeArgsForTests } from "../../runner/pty-process";
import {
  DEFAULT_ONESHOT_SETTINGS,
  type OneShotEngine,
  type OneShotRequest,
  type OneShotSettings,
  UNTRUSTED_CLAUDE_ARGS,
  listEngines,
  runOneShot,
} from "..";
import { printArgs } from "../print";
import { _setPtyOnceRunnerForTests, type PtyOnceRequest, ptyEngine } from "../pty";

const FORBIDDEN_UNTRUSTED = [
  "--mcp-config",
  "--resume",
  "--dangerously-skip-permissions",
  "--allowedTools",
  "--append-system-prompt",
  "--permission-mode",
];

/** True when `needle` appears in `hay` as one contiguous run, in order. */
function containsRun(hay: readonly string[], needle: readonly string[]): boolean {
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((v, j) => hay[i + j] === v)) return true;
  }
  return false;
}

interface Spawned {
  args: string[];
  cwd: unknown;
  env: unknown;
  cwdLiveAndEmpty: boolean;
  killed: string[];
}

function fakeSpawn(
  log: Spawned[],
  behaviour: { stdout?: string; code?: number; hang?: boolean } = {},
): typeof spawn {
  return ((_cmd: string, args: string[], options: { cwd?: unknown; env?: unknown }) => {
    const cwd = typeof options.cwd === "string" ? options.cwd : "";
    const rec: Spawned = {
      args,
      cwd: options.cwd,
      env: options.env,
      cwdLiveAndEmpty: cwd !== "" && existsSync(cwd) && readdirSync(cwd).length === 0,
      killed: [],
    };
    log.push(rec);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: (sig: string) => {
        rec.killed.push(sig);
        return true;
      },
    });
    if (!behaviour.hang) {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(behaviour.stdout ?? " ok \n"));
        child.emit("close", behaviour.code ?? 0);
      });
    }
    return child;
  }) as unknown as typeof spawn;
}

const ptyCalls: Array<PtyOnceRequest & { cwdLiveAndEmpty: boolean }> = [];
function fakePty(): void {
  _setPtyOnceRunnerForTests(async (req) => {
    ptyCalls.push({
      ...req,
      cwdLiveAndEmpty:
        typeof req.cwd === "string" && existsSync(req.cwd) && readdirSync(req.cwd).length === 0,
    });
    return { rawStdout: " pty ok \n", stderr: "", exitCode: 0, sessionId: "s-1" };
  });
}

afterEach(() => {
  _setPtyOnceRunnerForTests(null);
  ptyCalls.length = 0;
});

function on(engine: OneShotEngine): OneShotSettings {
  return { default: engine.id, engines: {}, routes: {} };
}

const untrusted: OneShotRequest = {
  route: "tuner.judge",
  prompt: "judge this",
  model: "some-model",
  isolation: "untrusted",
  timeoutMs: 5000,
};
const trusted: OneShotRequest = {
  route: "compact",
  prompt: "/compact",
  isolation: "trusted-session",
  resumeSessionId: "sess-123",
  timeoutMs: 5000,
};

/** argv of each claude engine for a request. Every claude engine must be here. */
const ARGV_OF: Record<string, (req: OneShotRequest) => string[]> = {
  print: (req) => printArgs(req),
  pty: (req) =>
    __buildClaudeArgsForTests({
      untrusted: req.isolation === "untrusted",
      sessionId: "stored-session",
      newSessionId: "fresh-session",
      cwd: tmpdir(),
      modelOverride: req.model,
      security: { level: "unrestricted", allowedTools: ["Bash"], disallowedTools: [] },
      securityArgs: ["--dangerously-skip-permissions"],
      appendSystemPrompt: "persona",
      mcpConfigPath: "/tmp/mcp.json",
      env: {},
    }),
};

describe("(a) untrusted argv of each claude engine", () => {
  it("UNTRUSTED_CLAUDE_ARGS is the full isolation set", () => {
    expect([...UNTRUSTED_CLAUDE_ARGS]).toEqual([
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--no-session-persistence",
      "--disable-slash-commands",
    ]);
  });

  it("every registered engine has an argv check", () => {
    for (const engine of listEngines()) expect(Object.keys(ARGV_OF)).toContain(engine.id);
  });

  for (const [id, argvOf] of Object.entries(ARGV_OF)) {
    it(`${id}: UNTRUSTED_CLAUDE_ARGS in order, nothing that reaches tools, MCP or a session`, () => {
      const args = argvOf(untrusted);
      expect(containsRun(args, UNTRUSTED_CLAUDE_ARGS)).toBe(true);
      for (const flag of FORBIDDEN_UNTRUSTED) expect(args).not.toContain(flag);
      expect(args[args.indexOf("--model") + 1]).toBe("some-model");
    });
  }

  it("pty: a trusted call keeps the operator's security, persona and MCP args", () => {
    const args = ARGV_OF.pty?.(trusted) ?? [];
    expect(containsRun(args, UNTRUSTED_CLAUDE_ARGS)).toBe(false);
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--mcp-config");
  });

  it("print: the prompt sits right after -p, ahead of the variadic --tools", () => {
    const args = printArgs(untrusted);
    expect(args[0]).toBe("-p");
    expect(args[1]).toBe("judge this");
    expect(args.indexOf("--tools")).toBeGreaterThan(1);
  });

  it("print: a prompt starting with a dash is not parsed as a flag", () => {
    const args = printArgs({ ...untrusted, prompt: "--dangerously-skip-permissions" });
    expect(args[1]).toBe(" --dangerously-skip-permissions");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("print: a trusted call resumes and takes allowedTools", () => {
    const args = printArgs({ ...trusted, allowedTools: ["Read", "Write"] });
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-123");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read Write");
    expect(containsRun(args, UNTRUSTED_CLAUDE_ARGS)).toBe(false);
  });

  it("print: the env-routed glm alias is left to the env, other models are passed", () => {
    for (const m of ["glm", "GLM", " glm "]) {
      expect(printArgs({ ...untrusted, model: m })).not.toContain("--model");
    }
    const args = printArgs({ ...untrusted, model: "kimi-k2p6" });
    expect(args[args.indexOf("--model") + 1]).toBe("kimi-k2p6");
  });
});

describe("(b) contract, for every registered engine", () => {
  for (const engine of listEngines()) {
    it(`${engine.id}: an untrusted call runs in an empty temp cwd removed after, or is refused`, async () => {
      fakePty();
      const log: Spawned[] = [];
      const call = runOneShot(untrusted, { settings: on(engine), spawn: fakeSpawn(log) });
      if (!engine.caps.isolation) {
        await expect(call).rejects.toThrow(/cannot run untrusted/);
        expect(log.length + ptyCalls.length).toBe(0);
        return;
      }
      const res = await call;
      expect(res.engine).toBe(engine.id);
      expect(res.exitCode).toBe(0);
      const seen = log[0] ?? ptyCalls[0];
      const cwd = String(log[0]?.cwd ?? ptyCalls[0]?.cwd);
      expect(seen?.cwdLiveAndEmpty).toBe(true);
      expect(cwd.startsWith(tmpdir())).toBe(true);
      expect(existsSync(cwd)).toBe(false);
    });

    it(`${engine.id}: a resume call reaches the engine, or is refused`, async () => {
      fakePty();
      const log: Spawned[] = [];
      const call = runOneShot(trusted, { settings: on(engine), spawn: fakeSpawn(log) });
      if (!engine.caps.resume) {
        await expect(call).rejects.toThrow(/cannot resume/);
        return;
      }
      const res = await call;
      expect(res.engine).toBe(engine.id);
      const passed = log[0]?.args.includes("sess-123") || ptyCalls[0]?.resumeSessionId;
      expect(Boolean(passed)).toBe(true);
      // A trusted call runs where it is, not in a throwaway dir.
      expect(log[0]?.cwd ?? ptyCalls[0]?.cwd).toBeUndefined();
    });

    it(`${engine.id}: allowedTools reach the engine, or are refused`, async () => {
      fakePty();
      const log: Spawned[] = [];
      const req = { ...trusted, resumeSessionId: undefined, allowedTools: ["Read"] };
      const call = runOneShot(req, { settings: on(engine), spawn: fakeSpawn(log) });
      if (!engine.caps.tools) {
        await expect(call).rejects.toThrow(/allowedTools/);
        return;
      }
      await call;
      expect(log[0]?.args).toContain("--allowedTools");
    });
  }
});

describe("(e) the isolation rule refuses what would undo it", () => {
  for (const extra of [{ resumeSessionId: "x" }, { allowedTools: ["Bash"] }]) {
    it(`untrusted + ${Object.keys(extra)[0]} rejects, nothing spawned`, async () => {
      const log: Spawned[] = [];
      await expect(
        runOneShot(
          { ...untrusted, ...extra },
          { settings: DEFAULT_ONESHOT_SETTINGS, spawn: fakeSpawn(log) },
        ),
      ).rejects.toThrow(/untrusted call cannot/);
      expect(log).toHaveLength(0);
    });
  }

  for (const route of ["discord.clasifier", "constructor", "toString"]) {
    it(`an unknown route (${route}) is refused, so it cannot skip the rule`, async () => {
      const log: Spawned[] = [];
      await expect(
        runOneShot(
          { ...trusted, route },
          { settings: DEFAULT_ONESHOT_SETTINGS, spawn: fakeSpawn(log) },
        ),
      ).rejects.toThrow(/unknown route/);
      expect(log).toHaveLength(0);
    });
  }

  it("a route that reads untrusted text cannot be called trusted", async () => {
    const log: Spawned[] = [];
    await expect(
      runOneShot(
        { ...untrusted, isolation: "trusted-session" },
        { settings: DEFAULT_ONESHOT_SETTINGS, spawn: fakeSpawn(log) },
      ),
    ).rejects.toThrow(/must run isolated/);
    expect(log).toHaveLength(0);
  });
});

describe("runOneShot", () => {
  it("routes by settings: a mapped route goes to its engine, others to the default", async () => {
    fakePty();
    const log: Spawned[] = [];
    const settings: OneShotSettings = { default: "print", engines: {}, routes: { compact: "pty" } };
    const a = await runOneShot(trusted, { settings, spawn: fakeSpawn(log) });
    const b = await runOneShot(
      { ...trusted, route: "rotation.summary" },
      { settings, spawn: fakeSpawn(log) },
    );
    expect([a.engine, b.engine]).toEqual(["pty", "print"]);
    expect(a.text).toBe("pty ok");
    expect(a.sessionId).toBe("s-1");
  });

  it("an engine declared in settings runs on its built-in type", async () => {
    const log: Spawned[] = [];
    const settings: OneShotSettings = {
      default: "cli",
      engines: { cli: { type: "print" } },
      routes: {},
    };
    const res = await runOneShot(untrusted, { settings, spawn: fakeSpawn(log) });
    expect(res.engine).toBe("print");
    expect(log).toHaveLength(1);
  });

  it("logs one line per call: route, engine, model, isolation, ms, exit", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      await runOneShot(untrusted, { settings: DEFAULT_ONESHOT_SETTINGS, spawn: fakeSpawn([]) });
    } finally {
      console.log = orig;
    }
    const line = lines.find((l) => l.startsWith("[oneshot]"));
    expect(line).toMatch(
      /^\[oneshot\] route=tuner\.judge engine=print model=some-model isolation=untrusted ms=\d+ exit=0$/,
    );
  });

  it("a refused call is logged too", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      await runOneShot(
        { ...untrusted, resumeSessionId: "x" },
        { settings: DEFAULT_ONESHOT_SETTINGS, spawn: fakeSpawn([]) },
      ).catch(() => {});
    } finally {
      console.log = orig;
    }
    expect(lines.find((l) => l.startsWith("[oneshot]"))).toMatch(/engine=print .* exit=refused$/);
  });

  it("print: returns trimmed stdout, and the exit code as is", async () => {
    const ok = await runOneShot(untrusted, {
      settings: DEFAULT_ONESHOT_SETTINGS,
      spawn: fakeSpawn([], { stdout: "  answer \n" }),
    });
    expect(ok.text).toBe("answer");
    const ko = await runOneShot(untrusted, {
      settings: DEFAULT_ONESHOT_SETTINGS,
      spawn: fakeSpawn([], { code: 2 }),
    });
    expect(ko.exitCode).toBe(2);
  });

  it("print: a call past timeoutMs is killed and returns 124", async () => {
    const log: Spawned[] = [];
    const res = await runOneShot(
      { ...untrusted, timeoutMs: 20 },
      { settings: DEFAULT_ONESHOT_SETTINGS, spawn: fakeSpawn(log, { hang: true }) },
    );
    expect(res.exitCode).toBe(124);
    expect(log[0]?.killed).toContain("SIGTERM");
  });

  it("print: an abort kills the call and returns 130", async () => {
    const log: Spawned[] = [];
    const ac = new AbortController();
    const call = runOneShot(
      { ...untrusted, signal: ac.signal },
      { settings: DEFAULT_ONESHOT_SETTINGS, spawn: fakeSpawn(log, { hang: true }) },
    );
    setTimeout(() => ac.abort(), 5);
    const res = await call;
    expect(res.exitCode).toBe(130);
    expect(log[0]?.killed).toContain("SIGTERM");
  });

  it("print: the child env is the request's, else cleanSpawnEnv()", async () => {
    const log: Spawned[] = [];
    await runOneShot(
      { ...untrusted, env: { ONLY: "this" } },
      { settings: DEFAULT_ONESHOT_SETTINGS, spawn: fakeSpawn(log) },
    );
    expect(log[0]?.env).toEqual({ ONLY: "this" });
  });
});

describe("pty engine", () => {
  it("hands the cwd, the isolation and the model to runOnceOnPty; system leads the prompt", async () => {
    fakePty();
    const res = await ptyEngine.run(
      { ...untrusted, system: "SYS" },
      { cwd: "/tmp/x", spawn: fakeSpawn([]) },
    );
    expect(ptyCalls[0]).toMatchObject({
      cwd: "/tmp/x",
      untrusted: true,
      modelOverride: "some-model",
      prompt: "SYS\n\njudge this",
      timeoutMs: 5000,
    });
    expect(res.text).toBe("pty ok");
  });
});
