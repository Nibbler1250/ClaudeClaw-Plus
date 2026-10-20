import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests, loadSettings } from "../config.js";
import { __buildClaudeArgsForTests, type PtyProcessOptions } from "../runner/pty-process.js";
import {
  __resetSupervisorForTests,
  injectOneShotTrustForTests,
  injectSpawnPty,
  runOnceOnPty,
} from "../runner/pty-supervisor.js";
import { untrustedPtyProjectDir } from "./pty-cleanup.js";
import { UNTRUSTED_CLAUDE_ARGS } from "./isolation.js";
import { engines } from "./registry.js";

let dir: string;
let savedConfig: string | undefined;
let savedIsolation: boolean;
let spawned: PtyProcessOptions[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pty-isolation-"));
  savedConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const file = join(dir, "settings.json");
  writeFileSync(file, "{}");
  _setSettingsFileForTests(file);
  await loadSettings();
  savedIsolation = engines.get("pty")!.caps.isolation;
  engines.get("pty")!.caps.isolation = true;
  spawned = [];
  injectOneShotTrustForTests(async () => {});
});

afterEach(() => {
  __resetSupervisorForTests();
  injectOneShotTrustForTests(null);
  engines.get("pty")!.caps.isolation = savedIsolation;
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  _setSettingsFileForTests();
  rmSync(dir, { recursive: true, force: true });
});

function fakeSpawn(onTurn: (opts: PtyProcessOptions) => void = () => {}): void {
  injectSpawnPty(async (opts) => {
    spawned.push(opts);
    return {
      label: "isolation",
      pid: 1,
      sessionId: "probe-session",
      cwd: opts.cwd,
      isAlive: () => true,
      lastTurnEndedAt: () => 0,
      runTurn: async () => {
        onTurn(opts);
        return { text: "ok", sessionId: "probe-session", cleanBoundary: true, bytesCaptured: 2 };
      },
      dispose: async () => {},
    } as never;
  });
}

const request = {
  route: "discord.classifier",
  prompt: "classify",
  isolation: "untrusted" as const,
  timeoutMs: 1000,
};

it("the actual untrusted PTY spawn preserves the complete shared isolation argv", async () => {
  fakeSpawn();
  expect((await runOnceOnPty(request)).exitCode).toBe(0);
  expect(spawned).toHaveLength(1);
  const args = __buildClaudeArgsForTests(spawned[0]!);
  expect(args.slice(args.indexOf("--tools"))).toEqual([...UNTRUSTED_CLAUDE_ARGS]);
});

for (const failure of [false, true]) {
  it(`removes external transcripts and the empty cwd after ${failure ? "failure" : "success"}`, async () => {
    let project = "";
    const sibling = join(dir, "projects", "another-project", "keep.jsonl");
    mkdirSync(join(dir, "projects", "another-project"), { recursive: true });
    writeFileSync(sibling, "keep");
    fakeSpawn((opts) => {
      project = untrustedPtyProjectDir(opts.cwd);
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "probe-session.jsonl"), "private prompt");
      if (failure) throw new Error("probe failure");
    });
    const result = await runOnceOnPty(request);
    expect(result.exitCode === 0).toBe(!failure);
    expect(project).not.toBe("");
    expect(existsSync(project)).toBe(false);
    expect(existsSync(spawned[0]!.cwd)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });
}
