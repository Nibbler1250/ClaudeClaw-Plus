import { writeFile, unlink, readdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import {
  getPidPath,
  cleanupPidFile,
  waitForPidExit,
  stopGraceMs,
  readConfiguredDrainMs,
} from "../pid";
import { getSession } from "../sessions";
import { loadSettings, type SecurityConfig } from "../config";
import { getMemoryPath } from "../memory";

const CLAUDE_DIR = join(process.cwd(), ".claude");
const HEARTBEAT_DIR = join(CLAUDE_DIR, "claudeclaw");
const STATUSLINE_FILE = join(CLAUDE_DIR, "statusline.cjs");
const CLAUDE_SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");

async function teardownStatusline() {
  try {
    const settings = await Bun.file(CLAUDE_SETTINGS_FILE).json();
    delete settings.statusLine;
    await writeFile(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // file doesn't exist, nothing to clean up
  }

  try {
    await unlink(STATUSLINE_FILE);
  } catch {
    // already gone
  }
}

async function preShutdownMemorySave(): Promise<void> {
  const session = await getSession();
  if (!session) return;

  const settings = await loadSettings();
  const memPath = getMemoryPath();
  console.log(`[shutdown] Saving memory to ${memPath}...`);

  try {
    // Always include Write tool so memory can be saved regardless of security level
    const securityArgs = ["--dangerously-skip-permissions"];
    if (settings.security.level === "locked") {
      securityArgs.push("--tools", "Read,Grep,Glob,Write");
    }

    const proc = Bun.spawn(
      [
        "claude",
        "-p",
        `Session is shutting down. Save your current memory to ${memPath} now. Include: current status, what was accomplished, key context for next session.`,
        "--output-format",
        "text",
        "--resume",
        session.sessionId,
        ...securityArgs,
        "--model",
        settings.model || "haiku",
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    await proc.exited;
    console.log("[shutdown] Memory saved.");
  } catch (e) {
    console.warn("[shutdown] Memory save failed:", e);
  }
}

export async function stop() {
  const pidFile = getPidPath();
  let pid: string;
  try {
    pid = (await Bun.file(pidFile).text()).trim();
  } catch {
    console.log("No daemon is running (PID file not found).");
    process.exit(0);
  }

  // Save memory before killing
  await preShutdownMemorySave();

  try {
    process.kill(Number(pid), "SIGTERM");
    // #315: the daemon drains its in-flight turns before exiting. Until it
    // is gone it still owns the bus socket and the agents, so it is not
    // "stopped" and its PID file must stay (a `start` meanwhile would launch
    // a second daemon on the same resources). Wait for it; force it past
    // the drain window, as a service manager would.
    const graceMs = stopGraceMs(await readConfiguredDrainMs(process.cwd()));
    console.log(
      `Sent SIGTERM to daemon (PID ${pid}); waiting up to ${Math.round(graceMs / 1000)}s for it to finish in-flight turns...`,
    );
    if (await waitForPidExit(Number(pid), graceMs)) {
      console.log(`Stopped daemon (PID ${pid}).`);
    } else {
      console.log(
        `Daemon (PID ${pid}) still alive after ${Math.round(graceMs / 1000)}s — sending SIGKILL.`,
      );
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        /* gone in between */
      }
      if (!(await waitForPidExit(Number(pid), 2000))) {
        // Still there after SIGKILL (uninterruptible sleep, zombie without a
        // reaper): it may still own the socket and the agents, so its PID
        // file stays — removing it would let a replacement start on top.
        console.log(
          `Daemon (PID ${pid}) did not exit after SIGKILL — leaving ${pidFile} in place; check the process before starting another daemon.`,
        );
        await teardownStatusline();
        process.exit(1);
      }
    }
  } catch {
    console.log(`Daemon process ${pid} already dead.`);
  }

  await cleanupPidFile();
  await teardownStatusline();

  try {
    await unlink(join(HEARTBEAT_DIR, "state.json"));
  } catch {
    // already gone
  }

  process.exit(0);
}

export async function stopAll() {
  const projectsDir = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    console.log("No projects found.");
    process.exit(0);
  }

  let found = 0;
  for (const dir of dirs) {
    const projectPath = "/" + dir.slice(1).replace(/-/g, "/");
    const pidFile = join(projectPath, ".claude", "claudeclaw", "daemon.pid");

    let pid: string;
    try {
      pid = (await readFile(pidFile, "utf-8")).trim();
      process.kill(Number(pid), 0);
    } catch {
      continue;
    }

    found++;
    try {
      process.kill(Number(pid), "SIGTERM");
      // #315: same as `stop` — the daemon drains before it exits; its PID
      // file goes only once it is gone. Each project's own settings.json
      // says how long its drain may take.
      const graceMs = stopGraceMs(await readConfiguredDrainMs(projectPath));
      let gone = await waitForPidExit(Number(pid), graceMs);
      if (gone) {
        console.log(`\x1b[33m■ Stopped\x1b[0m PID ${pid} — ${projectPath}`);
      } else {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {}
        gone = await waitForPidExit(Number(pid), 2000);
        console.log(
          gone
            ? `\x1b[33m■ Killed\x1b[0m PID ${pid} — ${projectPath} (still alive after ${Math.round(graceMs / 1000)}s)`
            : `\x1b[31m✗ Still alive after SIGKILL\x1b[0m PID ${pid} — ${projectPath} (PID file left in place)`,
        );
      }
      if (gone) {
        try {
          await unlink(pidFile);
        } catch {}
      }
    } catch {
      console.log(`\x1b[31m✗ Failed to stop\x1b[0m PID ${pid} — ${projectPath}`);
    }
  }

  if (found === 0) {
    console.log("No running daemons found.");
  }

  process.exit(0);
}
