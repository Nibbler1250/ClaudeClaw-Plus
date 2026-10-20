import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PtyProcess, spawnPty } from "./pty-process.js";

/**
 * #570 r12 (E): an untrusted prompt is written only into a REPL that is ready. A shell stands
 * in for claude: it prints a screen, then `cat`s everything written to the PTY into a file, so
 * "nothing was pasted" is an empty file rather than an inference.
 */

const FOOTER = "⏵⏵ auto mode on (shift+tab to cycle)";
let dir: string;
let sink: string;
let pidFile: string;
const spawned: PtyProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pty-ready-"));
  sink = join(dir, "received.txt");
  pidFile = join(dir, "child.pid");
});
afterEach(async () => {
  for (const child of spawned.splice(0)) await child.dispose().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

function spawnScreen(lines: string[], budgetMs = 1500): Promise<PtyProcess> {
  const printed = lines.map((l) => `'${l}'`).join(" ");
  return spawnPty({
    sessionId: "",
    cwd: dir,
    isolation: "untrusted",
    env: { PATH: "/usr/bin:/bin" },
    security: { level: "moderate", allowedTools: [], disallowedTools: [] },
    _commandOverride: "/bin/sh",
    _argsOverride: [
      "-c",
      `echo $$ > '${pidFile}'; printf '%s\\n' ${printed}; exec cat > '${sink}'`,
    ],
    quietWindowMs: 50,
    _replReadyBudgetMs: budgetMs,
  });
}

async function settled(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const received = (): string => (existsSync(sink) ? readFileSync(sink, "utf8") : "");

describe("untrusted spawn waits for a ready REPL", () => {
  it("fails on a login menu, with the reason, and writes nothing", async () => {
    // Went red (the spawn resolved, so the prompt would have been written) with the
    // blocked-screen check removed, and with the gate switched off for untrusted spawns.
    await expect(
      spawnScreen(["Select login method:", "1. Claude account", FOOTER]),
    ).rejects.toThrow(/not ready \(login-required\); nothing was sent/);
    await settled();
    expect(received()).toBe("");
  });

  it("retires the child it refused (the process is gone, not left at the login screen)", async () => {
    await expect(spawnScreen(["Select login method:", FOOTER])).rejects.toThrow(/login-required/);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // Went red (still alive) with the dispose before the rejection removed.
    expect(alive()).toBe(false);
  });

  // The REPL paints its footer in the logged-out state too; each wording is checked alone.
  // Went red per wording: the bare 'Not logged in' and the bare 'Run /login' each failed when
  // their own alternative was removed; only the combined string hid that.
  for (const status of ["Not logged in · Run /login", "Not logged in", "Please Run /login"]) {
    it(`fails on the logged-out status '${status}', though the footer is painted`, async () => {
      await expect(spawnScreen([status, FOOTER])).rejects.toThrow(/login-required/);
      await settled();
      expect(received()).toBe("");
    });
  }

  it("fails on an onboarding screen", async () => {
    // Went red with the onboarding pattern removed.
    await expect(spawnScreen(["Choose the text style that looks best", FOOTER])).rejects.toThrow(
      /onboarding/,
    );
  });

  it("fails when no footer arrives within the budget", async () => {
    // Went red (resolved) with the footer requirement dropped, and hung with the deadline removed.
    await expect(spawnScreen(["Loading..."], 400)).rejects.toThrow(/no-repl-footer/);
    await settled();
    expect(received()).toBe("");
  });

  it("twin: a screen with the footer and no blocking text is ready, and a prompt does reach the PTY", async () => {
    const child = await spawnScreen(["Claude Code v2.1.304", FOOTER]);
    spawned.push(child);
    await child.runTurn("PROMPT_REACHED_THE_PTY", { timeoutMs: 600 }).catch(() => {});
    // The sink records writes, so the empty files above mean something.
    expect(received()).toContain("PROMPT_REACHED_THE_PTY");
  });
});
