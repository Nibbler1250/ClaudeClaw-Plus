/**
 * Tests for sessions.ts agent-scoped paths
 *
 * Run with: bun test src/__tests__/sessions.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rm, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  getSession,
  createSession,
  peekSession,
  incrementTurn,
  markCompactWarned,
  resetSession,
  backupSession,
} from "../sessions";

const PROJECT = process.cwd();
const AGENTS_DIR = join(PROJECT, "agents");

const TEST_PREFIX = "tst-sess-";
const created: string[] = [];

function uniq(suffix: string): string {
  const name = `${TEST_PREFIX}${suffix}-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  created.push(name);
  return name;
}

async function cleanup(): Promise<void> {
  for (const name of created) {
    await rm(join(AGENTS_DIR, name), { recursive: true, force: true });
  }
  created.length = 0;
}

beforeEach(cleanup);
afterEach(cleanup);

describe("sessions agent-scoped", () => {
  it("getSession(name) returns null when no agent session exists", async () => {
    const name = uniq("none");
    await mkdir(join(AGENTS_DIR, name), { recursive: true });
    expect(await getSession(name)).toBeNull();
  });

  it("createSession + getSession round-trip for an agent", async () => {
    const name = uniq("rt");
    await mkdir(join(AGENTS_DIR, name), { recursive: true });
    await createSession("agent-sid-123", name);

    const sessionPath = join(AGENTS_DIR, name, "session.json");
    expect(existsSync(sessionPath)).toBe(true);

    const got = await getSession(name);
    expect(got).not.toBeNull();
    expect(got!.sessionId).toBe("agent-sid-123");
    expect(got!.turnCount).toBe(0);
    expect(got!.compactWarned).toBe(false);
  });

  it("agent session is isolated from main session cache", async () => {
    const name = uniq("iso");
    await mkdir(join(AGENTS_DIR, name), { recursive: true });
    await createSession("agent-only-sid", name);

    // The agent session must NOT leak into the main getSession() call
    // (we can't fully assert without touching real main session, but we can
    // assert the agent reads come from the agent file directly)
    const peek = await peekSession(name);
    expect(peek?.sessionId).toBe("agent-only-sid");
  });

  it("incrementTurn and markCompactWarned scoped to agent", async () => {
    const name = uniq("turn");
    await mkdir(join(AGENTS_DIR, name), { recursive: true });
    await createSession("sid-turn", name);

    const t1 = await incrementTurn(name);
    expect(t1).toBe(1);
    const t2 = await incrementTurn(name);
    expect(t2).toBe(2);

    await markCompactWarned(name);
    const peek = await peekSession(name);
    expect(peek?.compactWarned).toBe(true);
    expect(peek?.turnCount).toBe(2);
  });

  it("resetSession removes agent session file", async () => {
    const name = uniq("reset");
    await mkdir(join(AGENTS_DIR, name), { recursive: true });
    await createSession("sid-reset", name);
    const sessionPath = join(AGENTS_DIR, name, "session.json");
    expect(existsSync(sessionPath)).toBe(true);

    await resetSession(name);
    expect(existsSync(sessionPath)).toBe(false);
  });

  it("backupSession renames agent session file", async () => {
    const name = uniq("bk");
    await mkdir(join(AGENTS_DIR, name), { recursive: true });
    await createSession("sid-bk", name);

    const backupName = await backupSession(name);
    expect(backupName).not.toBeNull();
    const sessionPath = join(AGENTS_DIR, name, "session.json");
    expect(existsSync(sessionPath)).toBe(false);
    expect(existsSync(join(AGENTS_DIR, name, backupName!))).toBe(true);
  });
});
