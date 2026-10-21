/**
 * The one-shot print engine and the plugin CLI wrapper spawn `claudeExecutable()`,
 * not the bare `"claude"` (#573). On Windows the bare name is the `claude.cmd`
 * shim, which node's spawn does not run without a shell; `claudeExecutable()`
 * resolves `claude.exe` there and stays `"claude"` everywhere else.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { type PluginAction, buildArgs } from "../commands/plugin-cli";
import { runPrint, withPrintRuntime } from "../oneshot/print";
import { _setClaudeExecutableForTests, claudeExecutable } from "../runner/claude-executable";

const RESOLVED = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";

afterEach(() => _setClaudeExecutableForTests(null));

describe("claudeExecutable()", () => {
  it('is "claude" outside Windows', () => {
    if (process.platform === "win32") return;
    expect(claudeExecutable()).toBe("claude");
  });
});

describe("print engine spawn", () => {
  it("spawns claudeExecutable()", async () => {
    _setClaudeExecutableForTests(RESOLVED);
    const commands: string[] = [];
    const spawnFn = ((cmd: string) => {
      commands.push(cmd);
      const child = Object.assign(new EventEmitter(), {
        stdin: Object.assign(new EventEmitter(), { end() {} }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill() {},
      });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }) as unknown as typeof spawn;

    const result = await withPrintRuntime({ spawn: spawnFn }, () =>
      runPrint({ route: "test.spawn", prompt: "hi", isolation: "untrusted", timeoutMs: 5000 }),
    );

    expect(result.exitCode).toBe(0);
    expect(commands).toEqual([RESOLVED]);
  });
});

describe("plugin CLI argv", () => {
  const actions: PluginAction[] = [
    { kind: "marketplace-add", source: "https://example.com/plugins" },
    { kind: "marketplace-list" },
    { kind: "marketplace-update", name: "m" },
    { kind: "marketplace-update" },
    { kind: "marketplace-remove", name: "m" },
    { kind: "install", plugin: "p", scope: "user" },
    { kind: "list" },
    { kind: "uninstall", plugin: "p" },
    { kind: "enable", plugin: "p" },
    { kind: "disable", plugin: "p" },
  ];

  it.each(
    actions.map((a) => [a.kind, a] as const),
  )("%s starts with claudeExecutable()", (_kind, action) => {
    _setClaudeExecutableForTests(RESOLVED);
    const argv = buildArgs(action);
    expect(argv[0]).toBe(RESOLVED);
    expect(argv[1]).toBe("plugin");
  });
});
