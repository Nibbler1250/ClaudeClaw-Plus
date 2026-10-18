import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import type { spawn, SpawnOptions } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { ClaudeCliBackend } from "../llm.js";
import { TunerConfigSchema } from "../config.js";
import { cleanSpawnEnv } from "../../../runner/spawn-env.js";

// Every flag the backend may pass. All exist in `claude --help` (2.1.x); an
// unknown flag makes the CLI exit 1 before any model call.
const KNOWN_FLAGS = new Set([
  "-p",
  "--model",
  "--tools",
  "--strict-mcp-config",
  "--setting-sources",
  "--no-session-persistence",
  "--disable-slash-commands",
]);

interface Captured {
  command: string;
  args: string[];
  options: SpawnOptions;
  /** Whether the cwd existed (and was empty) while the child ran. */
  cwdLiveAndEmpty: boolean;
}

function fakeSpawn(captured: Captured[], stdout = "ok", code = 0): typeof spawn {
  return ((command: string, args: string[], options: SpawnOptions) => {
    const cwd = typeof options?.cwd === "string" ? options.cwd : "";
    captured.push({
      command,
      args,
      options,
      cwdLiveAndEmpty: cwd !== "" && existsSync(cwd) && readdirSync(cwd).length === 0,
    });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", code);
    });
    return child;
  }) as unknown as typeof spawn;
}

function backend(captured: Captured[]) {
  const config = TunerConfigSchema.parse({
    models: { judge: "judge-model", proposer_default: "proposer-model" },
  });
  return new ClaudeCliBackend(config, fakeSpawn(captured));
}

function argsAt(captured: Captured[], i: number): string[] {
  const call = captured[i];
  if (!call) throw new Error(`no spawn call #${i}`);
  return call.args;
}

/** The value that follows `flag` in `args`. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
}

function flagsOf(args: string[]): string[] {
  return args.filter((a) => a.startsWith("-"));
}

describe("ClaudeCliBackend — CLI arguments", () => {
  it("passes only flags the claude CLI accepts", async () => {
    const captured: Captured[] = [];
    await backend(captured).call("judge", "sys", [{ role: "user", content: "hi" }], 512);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.command).toBe("claude");
    const args = argsAt(captured, 0);
    for (const flag of flagsOf(args)) {
      expect(KNOWN_FLAGS.has(flag)).toBe(true);
    }
    expect(args).not.toContain("--max-tokens");
  });

  it("passes the model configured for the role", async () => {
    const captured: Captured[] = [];
    const b = backend(captured);
    await b.call("judge", "sys", [{ role: "user", content: "hi" }]);
    await b.call("proposer", "sys", [{ role: "user", content: "hi" }]);
    for (const [i, model] of ["judge-model", "proposer-model"].entries()) {
      expect(flagValue(argsAt(captured, i), "--model")).toBe(model);
    }
  });

  it("omits --model when the config has no models section", async () => {
    const captured: Captured[] = [];
    // zod 4 does not apply nested defaults under .default({}), so models is {}.
    const config = TunerConfigSchema.parse({});
    await new ClaudeCliBackend(config, fakeSpawn(captured)).call("judge", "sys", []);
    const args = argsAt(captured, 0);
    expect(args).not.toContain("--model");
    expect(args).not.toContain("undefined");
  });

  it("omits --model for the env-routed glm alias", async () => {
    const captured: Captured[] = [];
    const config = TunerConfigSchema.parse({ models: { judge: "GLM" } });
    await new ClaudeCliBackend(config, fakeSpawn(captured)).call("judge", "sys", []);
    expect(argsAt(captured, 0)).not.toContain("--model");
  });

  it("trims the configured model", async () => {
    const captured: Captured[] = [];
    const config = TunerConfigSchema.parse({ models: { judge: "  judge-model " } });
    await new ClaudeCliBackend(config, fakeSpawn(captured)).call("judge", "sys", []);
    expect(flagValue(argsAt(captured, 0), "--model")).toBe("judge-model");
  });

  it("disables built-in tools and MCP servers", async () => {
    const captured: Captured[] = [];
    await backend(captured).call("proposer", "sys", [{ role: "user", content: "hi" }]);
    const args = argsAt(captured, 0);
    expect(args).toContain("--tools");
    expect(flagValue(args, "--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
  });

  it("keeps the prompt right after -p, before the variadic --tools", async () => {
    const captured: Captured[] = [];
    await backend(captured).call("judge", "SYSTEM", [{ role: "user", content: "TURN" }]);
    const args = argsAt(captured, 0);
    const prompt = flagValue(args, "-p");
    expect(prompt).toContain("SYSTEM");
    expect(prompt).toContain("TURN");
    // --tools is variadic: a prompt placed after it would be read as a tool name.
    expect(args.indexOf("-p") + 1).toBeLessThan(args.indexOf("--tools"));
  });

  it("returns trimmed stdout on exit 0 and rejects on non-zero", async () => {
    const config = TunerConfigSchema.parse({});
    const ok = new ClaudeCliBackend(config, fakeSpawn([], "  answer \n", 0));
    expect(await ok.call("judge", "s", [])).toBe("answer");
    const ko = new ClaudeCliBackend(config, fakeSpawn([], "", 1));
    await expect(ko.call("judge", "s", [])).rejects.toThrow("claude CLI exited 1");
  });
});

describe("ClaudeCliBackend — isolation of the untrusted call", () => {
  it("loads no settings, hooks, session or slash commands", async () => {
    const captured: Captured[] = [];
    await backend(captured).call("judge", "sys", [{ role: "user", content: "hi" }]);
    const args = argsAt(captured, 0);
    expect(flagValue(args, "--tools")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--setting-sources");
    expect(flagValue(args, "--setting-sources")).toBe("");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--disable-slash-commands");
    for (const flag of [
      "--mcp-config",
      "--resume",
      "--dangerously-skip-permissions",
      "--allowedTools",
    ]) {
      expect(args).not.toContain(flag);
    }
  });

  it("spawns with cleanSpawnEnv(), not the daemon env", async () => {
    const saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDECODE: process.env.CLAUDECODE,
    };
    process.env.ANTHROPIC_API_KEY = "sk-test-not-a-real-key";
    process.env.CLAUDECODE = "1";
    try {
      const captured: Captured[] = [];
      await backend(captured).call("judge", "sys", []);
      const env = captured[0]?.options.env;
      expect(env).toBeDefined();
      expect(env).not.toBe(process.env);
      expect(env).toEqual(cleanSpawnEnv());
      expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env?.CLAUDECODE).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  for (const code of [0, 1]) {
    it(`runs in an empty temp cwd that is removed after exit ${code}`, async () => {
      const captured: Captured[] = [];
      const config = TunerConfigSchema.parse({});
      const b = new ClaudeCliBackend(config, fakeSpawn(captured, "x", code));
      const call = b.call("judge", "sys", []);
      if (code === 0) await call;
      else await expect(call).rejects.toThrow("claude CLI exited 1");
      const cwd = captured[0]?.options.cwd;
      expect(typeof cwd).toBe("string");
      expect(String(cwd).startsWith(tmpdir())).toBe(true);
      expect(String(cwd)).not.toBe(process.cwd());
      expect(captured[0]?.cwdLiveAndEmpty).toBe(true);
      expect(existsSync(String(cwd))).toBe(false);
    });
  }

  it("removes the temp cwd when the spawn itself fails", async () => {
    let seenCwd = "";
    const failing = ((_c: string, _a: string[], options: SpawnOptions) => {
      seenCwd = String(options.cwd);
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("spawn claude ENOENT")));
      return child;
    }) as unknown as typeof spawn;
    const b = new ClaudeCliBackend(TunerConfigSchema.parse({}), failing);
    await expect(b.call("judge", "sys", [])).rejects.toThrow("ENOENT");
    expect(seenCwd.startsWith(tmpdir())).toBe(true);
    expect(existsSync(seenCwd)).toBe(false);
  });
});
