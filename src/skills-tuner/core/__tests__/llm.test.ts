import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { ClaudeCliBackend } from "../llm.js";
import { TunerConfigSchema } from "../config.js";

// Every flag the backend may pass. All exist in `claude --help` (2.1.x); an
// unknown flag makes the CLI exit 1 before any model call.
const KNOWN_FLAGS = new Set(["-p", "--model", "--tools", "--strict-mcp-config"]);

interface Captured {
  command: string;
  args: string[];
}

function fakeSpawn(captured: Captured[], stdout = "ok", code = 0): typeof spawn {
  return ((command: string, args: string[]) => {
    captured.push({ command, args });
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
