import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EscapeScanUnknownError, findEscapees, terminateEscapees } from "./pty-escape-scan.js";
import { type PtyProcessOptions, spawnPty } from "./pty-process.js";

/**
 * #570 r13 (C): a descendant that leaves claude's process group (`setsid`, `setpgid`) escapes
 * the group kill. On Linux it is found by the throwaway config root it inherited, or by running
 * inside the throwaway cwd. The fake-/proc half runs everywhere; the real-process half only on
 * Linux, where `setsid(1)` and `/proc` exist.
 */

const ROOT = "/tmp/claudeclaw-oneshot-cfg-AAAA";
const CWD = "/tmp/claudeclaw-oneshot-pty-BBBB";
const TARGET = { root: ROOT, cwds: [CWD] };
const START = 1_700_000_000_000;

describe("findEscapees (fake /proc)", () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), "fake-proc-"));
  });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  const process_ = (pid: number, { env, cwd }: { env?: string[]; cwd?: string }): void => {
    mkdirSync(join(proc, String(pid)));
    if (env) writeFileSync(join(proc, String(pid), "environ"), `${env.join("\0")}\0`);
    if (cwd) symlinkSync(cwd, join(proc, String(pid), "cwd"));
  };

  it("finds a process that carries this root in its environment, by exact entry", () => {
    process_(5001, { env: ["PATH=/bin", `CLAUDE_CONFIG_DIR=${ROOT}`, "HOME=/x"] });
    process_(5002, { env: [`CLAUDE_CONFIG_DIR=${ROOT}-other`] }); // a longer path
    process_(5003, { env: [`X_CLAUDE_CONFIG_DIR=${ROOT}`] }); // another variable
    process_(5004, { env: [`CLAUDE_CONFIG_DIR=${ROOT.slice(0, -1)}`] }); // a shorter path
    process_(5005, { env: ["PATH=/bin"] });
    expect(findEscapees(TARGET, { procDir: proc, selfPid: 1 }).pids).toEqual([5001]);
  });

  it("finds a process running in the temp cwd or below it, and not a sibling with the same prefix", () => {
    process_(5101, { cwd: CWD });
    process_(5102, { cwd: `${CWD}/sub/dir` });
    process_(5103, { cwd: `${CWD}-sibling` });
    process_(5104, { cwd: "/" });
    expect(findEscapees(TARGET, { procDir: proc, selfPid: 1 }).pids.sort()).toEqual([5101, 5102]);
  });

  it("matches the temp cwd in either of its forms", () => {
    process_(5201, { cwd: "/private/tmp/claudeclaw-oneshot-pty-BBBB" });
    const target = { root: ROOT, cwds: [CWD, "/private/tmp/claudeclaw-oneshot-pty-BBBB"] };
    expect(findEscapees(target, { procDir: proc, selfPid: 1 }).pids).toEqual([5201]);
  });

  it("skips the daemon itself and pids that cannot be signalled", () => {
    process_(5301, { env: [`CLAUDE_CONFIG_DIR=${ROOT}`] });
    process_(1, { env: [`CLAUDE_CONFIG_DIR=${ROOT}`] });
    mkdirSync(join(proc, "self"));
    expect(findEscapees(TARGET, { procDir: proc, selfPid: 5301 })).toEqual({
      pids: [],
      unknown: false,
    });
    expect(findEscapees(TARGET, { procDir: proc, selfPid: 1 }).pids).toEqual([5301]);
  });

  it("reports unknown for a process of ours whose environment cannot be read", () => {
    mkdirSync(join(proc, "5302"));
    mkdirSync(join(proc, "5302", "environ")); // reading a directory fails (EISDIR), not ENOENT
    expect(findEscapees(TARGET, { procDir: proc, selfPid: 1 })).toEqual({
      pids: [],
      unknown: true,
    });
  });

  it("reports unknown for a process of ours whose cwd cannot be read", () => {
    mkdirSync(join(proc, "5303"));
    writeFileSync(join(proc, "5303", "environ"), "PATH=/bin\0");
    writeFileSync(join(proc, "5303", "cwd"), "not a link"); // readlink on a file fails (EINVAL)
    expect(findEscapees(TARGET, { procDir: proc, selfPid: 1 }).unknown).toBe(true);
  });

  it("does not report unknown for a process that is gone, or one owned by another uid", () => {
    mkdirSync(join(proc, "5304")); // no environ, no cwd: both reads fail with ENOENT
    mkdirSync(join(proc, "5305"));
    mkdirSync(join(proc, "5305", "environ")); // unreadable, but not ours:
    const foreign = (process.getuid?.() ?? 0) + 1;
    expect(findEscapees(TARGET, { procDir: proc, selfPid: 1, uid: foreign })).toEqual({
      pids: [],
      unknown: false,
    });
    rmSync(join(proc, "5305"), { recursive: true });
    expect(findEscapees(TARGET, { procDir: proc, selfPid: 1 })).toEqual({
      pids: [],
      unknown: false,
    });
  });

  it("still names a match when another process could not be read", () => {
    process_(5306, { env: [`CLAUDE_CONFIG_DIR=${ROOT}`] });
    mkdirSync(join(proc, "5307"));
    mkdirSync(join(proc, "5307", "environ"));
    expect(findEscapees(TARGET, { procDir: proc, selfPid: 1 })).toEqual({
      pids: [5306],
      unknown: true,
    });
  });

  it("throws when /proc cannot be listed, and finds nothing for a root nobody carries", () => {
    expect(() => findEscapees(TARGET, { procDir: join(proc, "missing") })).toThrow();
    const scan = findEscapees({ root: `/tmp/no-such-root-${process.pid}-${Date.now()}`, cwds: [] });
    expect(scan.pids).toEqual([]);
  });
});

describe("terminateEscapees (fake /proc)", () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), "fake-proc-"));
  });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  const spawnFake = (pid: number): void => {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(join(proc, String(pid), "environ"), `CLAUDE_CONFIG_DIR=${ROOT}\0`);
  };
  /** A kernel on which the process dies of `diesOn` (never, when null). */
  const kernel = (diesOn: NodeJS.Signals | null) => {
    const sent: Array<[number, NodeJS.Signals | 0]> = [];
    return {
      sent,
      signal: (pid: number, name: NodeJS.Signals | 0): void => {
        sent.push([pid, name]);
        if (name === diesOn) rmSync(join(proc, String(pid)), { recursive: true, force: true });
      },
    };
  };
  const fast = { sleep: async () => {}, pollMs: 100, termGraceMs: 100, killGraceMs: 100 };

  it("SIGTERMs an escapee, and is done once the scan comes back empty", async () => {
    spawnFake(6001);
    const k = kernel("SIGTERM");
    const left = await terminateEscapees(TARGET, {
      procDir: proc,
      selfPid: 1,
      signal: k.signal,
      startMs: () => START,
      ...fast,
    });
    expect(left).toEqual([]);
    expect(k.sent).toEqual([[6001, "SIGTERM"]]);
  });

  it("escalates to SIGKILL for one that ignores SIGTERM", async () => {
    spawnFake(6002);
    const k = kernel("SIGKILL");
    const left = await terminateEscapees(TARGET, {
      procDir: proc,
      selfPid: 1,
      signal: k.signal,
      startMs: () => START,
      ...fast,
    });
    expect(left).toEqual([]);
    expect(k.sent).toEqual([
      [6002, "SIGTERM"],
      [6002, "SIGKILL"],
    ]);
  });

  it("reports an escapee that outlives SIGKILL, never success", async () => {
    spawnFake(6003);
    const k = kernel(null);
    const left = await terminateEscapees(TARGET, {
      procDir: proc,
      selfPid: 1,
      signal: k.signal,
      startMs: () => START,
      ...fast,
    });
    expect(left).toEqual([6003]);
  });

  it("does not signal a pid whose start time changed since it was found", async () => {
    spawnFake(6004);
    const k = kernel("SIGTERM");
    let reads = 0;
    const left = await terminateEscapees(TARGET, {
      procDir: proc,
      selfPid: 1,
      signal: k.signal,
      startMs: () => (reads++ === 0 ? START : START + 3_600_000), // reused after the scan
      ...fast,
    });
    expect(k.sent).toEqual([]);
    expect(left).toEqual([6004]);
  });

  it("does not signal a pid whose start time cannot be read", async () => {
    spawnFake(6005);
    const k = kernel("SIGTERM");
    const left = await terminateEscapees(TARGET, {
      procDir: proc,
      selfPid: 1,
      signal: k.signal,
      startMs: () => null,
      ...fast,
    });
    expect(k.sent).toEqual([]);
    expect(left).toEqual([6005]);
  });

  it("throws, never reports success, when nothing was found but a process could not be read", async () => {
    mkdirSync(join(proc, "6006"));
    mkdirSync(join(proc, "6006", "environ")); // unreadable and ours
    const k = kernel("SIGTERM");
    await expect(
      terminateEscapees(TARGET, { procDir: proc, selfPid: 1, signal: k.signal, ...fast }),
    ).rejects.toBeInstanceOf(EscapeScanUnknownError);
    expect(k.sent).toEqual([]);
  });

  it("throws when the escapee dies but a process of ours still could not be read afterwards", async () => {
    spawnFake(6007);
    mkdirSync(join(proc, "6008"));
    mkdirSync(join(proc, "6008", "environ")); // never readable: the last scan stays unknown
    const k = kernel("SIGTERM");
    await expect(
      terminateEscapees(TARGET, {
        procDir: proc,
        selfPid: 1,
        signal: k.signal,
        startMs: () => START,
        ...fast,
      }),
    ).rejects.toBeInstanceOf(EscapeScanUnknownError);
    expect(k.sent.map(([pid]) => pid)).toContain(6007); // the known one was still stopped
  });

  it("throws when /proc cannot be listed", async () => {
    await expect(
      terminateEscapees(TARGET, { procDir: join(proc, "missing"), ...fast }),
    ).rejects.toThrow();
  });

  it("is a no-op when there is nothing to stop", async () => {
    const k = kernel("SIGTERM");
    expect(
      await terminateEscapees(TARGET, { procDir: proc, selfPid: 1, signal: k.signal, ...fast }),
    ).toEqual([]);
    expect(k.sent).toEqual([]);
  });
});

// ─── Linux only: a real descendant that leaves the group ──────────────────────

describe.skipIf(process.platform !== "linux")("a descendant that calls setsid() (Linux)", () => {
  let dir: string;
  let root: string;
  const strays: number[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pty-escape-"));
    root = join(dir, "cfg-root");
    mkdirSync(root);
  });
  afterEach(() => {
    const target = { root, cwds: [] as string[] };
    for (const pid of [...strays.splice(0), ...findEscapees(target).pids]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  async function until(condition: () => boolean, ms = 5000): Promise<void> {
    for (const start = Date.now(); !condition(); ) {
      if (Date.now() - start > ms) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * A PTY child whose helper moves to its own session (so also its own process group) and carries
   * the throwaway root, as a daemonised git or a setsid() helper of claude would. The helper
   * writes its own pid, which `exec` keeps, so it is told apart from the shell that carries the
   * same environment.
   */
  async function spawnEscaping(extra: Partial<PtyProcessOptions>) {
    const pidFile = join(dir, "escapee.pid");
    const child = await spawnPty({
      sessionId: "",
      cwd: dir,
      isolation: "untrusted",
      env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: root },
      security: { level: "moderate", allowedTools: [], disallowedTools: [] },
      _commandOverride: "/bin/sh",
      _argsOverride: [
        "-c",
        `setsid sh -c 'echo $$ > ${pidFile}; trap "" HUP; exec sleep 60' & sleep 60`,
      ],
      _skipReadySettle: true,
      ...extra,
    });
    strays.push(child.pid);
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const escapee = Number(readFileSync(pidFile, "utf8").trim());
    strays.push(escapee);
    const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(escapee)]).toString());
    expect(pgid).not.toBe(child.pid); // it is outside the group the kill reaches
    return { child, escapee };
  }

  it("is dead once the child is retired", async () => {
    const { child, escapee } = await spawnEscaping({
      reapEscapees: async () => terminateEscapees({ root, cwds: [] }),
    });
    expect(alive(escapee)).toBe(true);
    await child.dispose();
    expect(alive(escapee)).toBe(false);
  });

  it("twin: with the scan switched off it survives the group kill (so the test above can fail)", async () => {
    const { child, escapee } = await spawnEscaping({});
    await child.dispose();
    expect(alive(escapee)).toBe(true); // killed in afterEach
  });
});
