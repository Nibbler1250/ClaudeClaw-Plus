/**
 * The Discord thread-intent classifier runs `claude --print` on a message
 * written by a guild member. It used to inherit every built-in tool, every
 * MCP server and the daemon's full env — so a message could ask it to run a
 * shell command or read a file, and its output was parsed for thread names.
 * It now runs with no tools, no MCP, and an allowlisted env.
 */
import { describe, expect, it } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { CLASSIFIER_MODEL, classifierRequest, classifierSpawnEnv } from "../commands/discord";
import { DEFAULT_ONESHOT_SETTINGS, runOneShot } from "../oneshot";

/** The argv and options the classifier's `claude` is spawned with (#548). */
async function classifierSpawn(): Promise<{ args: string[]; env: unknown; cwd: unknown }> {
  let seen: { args: string[]; env: unknown; cwd: unknown } | undefined;
  const fake = ((_cmd: string, args: string[], options: { env?: unknown; cwd?: unknown }) => {
    seen = { args, env: options.env, cwd: options.cwd };
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  }) as unknown as typeof spawn;
  await runOneShot(classifierRequest("message"), {
    settings: DEFAULT_ONESHOT_SETTINGS,
    spawn: fake,
  });
  if (!seen) throw new Error("classifier did not spawn");
  return seen;
}

describe("classifyThreadIntent isolation", () => {
  it("disables every built-in tool and every MCP server", async () => {
    const { args } = await classifierSpawn();
    const i = args.indexOf("--tools");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
    expect(args).toContain("-p");
    expect(args[args.indexOf("--model") + 1]).toBe(CLASSIFIER_MODEL);
  });

  it("loads no settings file (hooks, user plugins) and no skills", async () => {
    const { args } = await classifierSpawn();
    const i = args.indexOf("--setting-sources");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("");
    expect(args).toContain("--disable-slash-commands");
  });

  it("spawns with the allowlisted env, from an empty temp dir", async () => {
    const { env, cwd } = await classifierSpawn();
    expect(env).toEqual(classifierSpawnEnv());
    expect(typeof cwd).toBe("string");
    expect(String(cwd)).not.toBe(process.cwd());
  });

  it("passes model auth and basics, drops chat tokens and other daemon secrets", () => {
    const env = classifierSpawnEnv({
      PATH: "/usr/bin",
      HOME: "/somewhere/else",
      LANG: "C.UTF-8",
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      CLAUDE_CODE_OAUTH_TOKEN: "oat",
      HTTPS_PROXY: "http://proxy:3128",
      DISCORD_TOKEN: "discord-secret",
      TELEGRAM_TOKEN: "telegram-secret",
      GITHUB_TOKEN: "gh-secret",
      SSH_AUTH_SOCK: "/run/agent.sock",
      DATABASE_URL: "postgres://u:p@db/x",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: homedir(),
      LANG: "C.UTF-8",
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_BASE_URL: "https://proxy.example",
      CLAUDE_CODE_OAUTH_TOKEN: "oat",
      HTTPS_PROXY: "http://proxy:3128",
    });
  });
});
