import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { encodeCwdForProjectsDir } from "../bus/jsonl-line-types.js";

/** Where an interactive claude with this env keeps its state. */
export interface ChildConfigRoot {
  /** `CLAUDE_CONFIG_DIR`, else `$HOME/.claude`: holds `projects/`, `history.jsonl`, `sessions/`... */
  configDir: string;
  /** `CLAUDE_CONFIG_DIR`, else `$HOME`: holds the global `.claude.json` (trust entries). */
  globalDir: string;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

/**
 * The config root the CHILD will use, from the env it is spawned with (not the
 * parent's `homedir()`). An empty `CLAUDE_CONFIG_DIR` or `HOME` counts as unset,
 * as it does for claude. A relative root would resolve against whatever cwd the
 * caller happens to have, so it fails closed before any spawn.
 */
export function resolveChildConfigRoot(env: Record<string, string | undefined>): ChildConfigRoot {
  const explicit = nonEmpty(env.CLAUDE_CONFIG_DIR);
  const home = nonEmpty(env.HOME) ?? homedir();
  const configDir = explicit ?? join(home, ".claude");
  const globalDir = explicit ?? home;
  if (!isAbsolute(configDir) || !isAbsolute(globalDir)) {
    throw new Error("untrusted PTY one-shot requires an absolute Claude config root");
  }
  return { configDir, globalDir };
}

/** Only called for the unique mkdtemp cwd owned by an untrusted one-shot. */
export function untrustedPtyProjectDir(
  cwd: string,
  configDir = nonEmpty(process.env.CLAUDE_CONFIG_DIR) ?? join(homedir(), ".claude"),
): string {
  return join(configDir, "projects", encodeCwdForProjectsDir(realpathSync(cwd)));
}

/** Interactive Claude ignores --no-session-persistence; retire it before cleanup. */
export function removeUntrustedPtyTranscripts(projectDir: string): void {
  rmSync(projectDir, { recursive: true, force: true });
}

/** A claude session id (a UUID). Anything else never reaches a path: ids come off disk. */
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{7,63}$/;

/**
 * Session ids an interactive claude used in `projectDir`: the `<id>.jsonl` names it wrote,
 * plus any the caller already knows. Read BEFORE the transcripts are removed.
 */
export function untrustedSessionIds(
  projectDir: string,
  known: Array<string | undefined> = [],
): string[] {
  const ids = new Set<string>();
  for (const id of known) if (id !== undefined && SESSION_ID.test(id)) ids.add(id);
  if (existsSync(projectDir)) {
    for (const entry of readdirSync(projectDir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const id = entry.slice(0, -".jsonl".length);
      if (SESSION_ID.test(id)) ids.add(id);
    }
  }
  return [...ids];
}

/** The cwd as given and as resolved: claude may record either. */
export function untrustedCwdForms(cwd: string): string[] {
  const forms = new Set([cwd]);
  try {
    forms.add(realpathSync(cwd));
  } catch {
    /* already gone */
  }
  return [...forms];
}

const HISTORY_LOCK_WAIT_MS = 3_000;
const HISTORY_LOCK_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Not allowed on this thread: a short bounded spin instead.
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* wait */
    }
  }
}

/**
 * `mkdir <file>.lock` is the lock convention of `proper-lockfile`, which claude is
 * believed to use for this file (see the spike doc for what the live run saw). A lock older
 * than the library's default stale window is taken over. Holding it for the
 * read-modify-rename keeps a concurrent claude's append from being lost in between.
 * Every path through the loop is bounded by the deadline, so a lock that cannot be taken
 * or cleared fails closed instead of spinning.
 */
function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + HISTORY_LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("history.jsonl lock is held");
      try {
        if (Date.now() - lstatSync(lock).mtimeMs > HISTORY_LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        // released (or unreadable) between the mkdir and the stat: pause, then retry
      }
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Drop this one-shot's lines from `<configDir>/history.jsonl`: those whose `project` is the
 * throwaway cwd or whose `sessionId` is one of its sessions. Interactive claude writes the
 * submitted prompt there. Other lines, and lines that do not parse, are kept as they are.
 * Returns the number of lines removed.
 */
export function removeUntrustedHistory(
  configDir: string,
  cwds: string[],
  sessionIds: string[],
): number {
  const file = join(configDir, "history.jsonl");
  if (!existsSync(file)) return 0;
  return withFileLock(file, () => {
    const lines = readFileSync(file, "utf8").split("\n");
    let removed = 0;
    const kept = lines.filter((line) => {
      if (line.trim() === "") return true;
      try {
        const entry = JSON.parse(line) as { project?: unknown; sessionId?: unknown };
        const mine =
          (typeof entry.project === "string" && cwds.includes(entry.project)) ||
          (typeof entry.sessionId === "string" && sessionIds.includes(entry.sessionId));
        if (mine) removed++;
        return !mine;
      } catch {
        return true;
      }
    });
    if (removed === 0) return 0;
    const mode = statSync(file).mode & 0o777;
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, kept.join("\n"), { mode });
    renameSync(tmp, file);
    return removed;
  });
}

/**
 * Remove the per-session state an interactive claude keeps under the config root, by
 * session id (and, for `sessions/*.json`, by cwd): `session-env/<id>`, `file-history/<id>`,
 * `debug/<id>.txt`, `todos/<id>*`. Only ever called with ids that passed `SESSION_ID`.
 */
export function removeUntrustedSessionFiles(
  configDir: string,
  cwds: string[],
  sessionIds: string[],
): void {
  for (const id of sessionIds) {
    if (!SESSION_ID.test(id)) continue;
    rmSync(join(configDir, "session-env", id), { recursive: true, force: true });
    rmSync(join(configDir, "file-history", id), { recursive: true, force: true });
    rmSync(join(configDir, "debug", `${id}.txt`), { force: true });
    const todos = join(configDir, "todos");
    if (existsSync(todos)) {
      for (const name of readdirSync(todos)) {
        if (name.startsWith(id)) rmSync(join(todos, name), { recursive: true, force: true });
      }
    }
  }
  const sessions = join(configDir, "sessions");
  if (!existsSync(sessions)) return;
  for (const name of readdirSync(sessions)) {
    const path = join(sessions, name);
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as {
        sessionId?: unknown;
        cwd?: unknown;
      };
      const mine =
        (typeof entry.sessionId === "string" && sessionIds.includes(entry.sessionId)) ||
        (typeof entry.cwd === "string" && cwds.includes(entry.cwd));
      if (mine) rmSync(path, { recursive: true, force: true });
    } catch {
      /* not a session record */
    }
  }
}
