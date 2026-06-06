/**
 * Provider-aligned observation readers (P1 — fix the obs=0 plumbing).
 *
 * The modern `buildHostTelemetryProvider` reads each subject's behavioural data
 * from its DEDICATED file and feeds the fitness layer. But every subject's
 * `collectObservations` path uses a SEPARATE legacy reader pointed at the wrong
 * source (operations.jsonl for mcp tool calls; an unconfigured `() => []` for
 * mode dispatch), so observations were always empty → 0 proposals.
 *
 * These factory readers close that gap: they read the SAME dedicated files the
 * telemetry provider reads, mapped into the event shape each subject's
 * `collectObservations` already expects. Synchronous + file-based to match the
 * existing reader seams (the provider's `query` is async and cannot be awaited
 * inside the sync reader contract).
 *
 * Wired in `registerWisecronSubjects`; each subject keeps its injectable seam,
 * so tests can still override with fixtures.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TOOL_CALL_LOG } from "../../observability/tool-call-sink.js";
import { DEFAULT_MODE_DISPATCH_LOG } from "../../governance/mode-dispatch-journal.js";
import {
  type SessionJsonlProducerConfig,
  SessionJsonlTelemetryProducer,
} from "./session-jsonl-provider.js";

function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, homedir()) : p;
}

/** Read JSONL, skipping blank/malformed lines and entries older than `since`. */
function readJsonlSince(path: string, since: Date): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj !== "object" || obj === null) continue;
      out.push(obj as Record<string, unknown>);
    } catch {
      /* skip malformed line */
    }
  }
  // Time filtering is applied by the caller's mapper (the ts field differs per
  // source), so return everything parsed here.
  void since;
  return out;
}

/**
 * `McpPluginSubject.auditReader` adapter over the hash-chained `mcp.tool_call`
 * log (`~/.claudeclaw/telemetry/mcp-tool-calls.jsonl`). Each chained entry
 * `{ ts, event:"mcp.tool_call", subject:<server>, detail:{ tool, status, … } }`
 * maps to the `{ type:"mcp_tool_call", server, tool, success, blocked, ts }`
 * shape `collectObservations` filters on. Ignores the legacy `path` arg the
 * subject passes (its default points at operations.jsonl, which never carries
 * these events) in favour of the dedicated source.
 */
export function makeMcpToolCallReader(
  logPath: string = DEFAULT_TOOL_CALL_LOG,
): (path: string, since: Date) => Array<Record<string, unknown>> {
  const source = expandHome(logPath);
  return (_legacyPath: string, since: Date) => {
    const out: Array<Record<string, unknown>> = [];
    for (const entry of readJsonlSince(source, since)) {
      if (entry.event !== "mcp.tool_call") continue;
      const ts = entry.ts;
      if (ts) {
        const tsDate = new Date(ts as string | number);
        if (!Number.isNaN(tsDate.getTime()) && tsDate < since) continue;
      }
      const detail = (entry.detail as Record<string, unknown>) ?? {};
      const status = String(detail.status ?? "");
      out.push({
        type: "mcp_tool_call",
        server: String(entry.subject ?? "unknown"),
        tool: String(detail.tool ?? "unknown"),
        success: status === "ok" || status === "success",
        blocked: status === "blocked" || status === "denied",
        ts: entry.ts,
      });
    }
    return out;
  };
}

/**
 * EXPERIMENT (Task 3 — 1-reader de-risk): `McpPluginSubject.auditReader` over
 * the SESSION TRANSCRIPTS instead of the dedicated `mcp-tool-calls.jsonl` sink.
 *
 * The dedicated sink stopped being written (stale since 2026-05-28), so the
 * legacy reader time-filters every entry out → obs=0. The session transcripts
 * (`~/.claude/projects/<enc-cwd>/<session>.jsonl`) are the abundant, live source
 * of `tool_use` events. This reuses `SessionJsonlTelemetryProducer` (which in
 * turn consumes the Bus's read-only `jsonl-line-types` helpers) and maps its
 * `tool_call` MetricSamples into the `{ type:"mcp_tool_call", server, tool,
 * success, blocked, ts }` shape `collectObservations` expects. Only MCP tools
 * (`mcp__<server>__<tool>` → non-empty server) are surfaced; bare harness tools
 * (Read/Bash/…) are not mcp_plugin telemetry and are dropped.
 *
 * If this yields obs>0 the same pattern generalises to `model_routing`'s
 * `mode_dispatch` — but mode_dispatch is NOT derivable from a transcript (the
 * provider advertises it inactive-by-design), so that generalisation is bounded.
 */
export function makeSessionToolCallReader(
  cfg: SessionJsonlProducerConfig = {},
): (path: string, since: Date) => Array<Record<string, unknown>> {
  const producer = new SessionJsonlTelemetryProducer(cfg);
  return (_legacyPath: string, since: Date) => {
    const range = { start: since, end: new Date() };
    const out: Array<Record<string, unknown>> = [];
    for (const s of producer.collectSamples("tool_call", range)) {
      const server = String(s.labels?.server ?? "");
      if (!server) continue; // MCP tools only — bare harness tools aren't plugins.
      // provider labels.tool is the full `mcp__<server>__<tool>` name; strip the
      // prefix to the bare tool, matching the dedicated-sink reader's shape.
      const fullName = String(s.labels?.tool ?? "unknown");
      const tool = fullName.startsWith("mcp__")
        ? fullName.split("__").slice(2).join("__")
        : fullName;
      out.push({
        type: "mcp_tool_call",
        server,
        tool,
        // provider encodes failure as value=1 (matched tool_result is_error).
        success: s.value === 0,
        blocked: s.labels?.blocked === "true",
        ts: s.ts instanceof Date ? s.ts.toISOString() : s.ts,
      });
    }
    return out;
  };
}

/**
 * `ModelRoutingSubject.dispatchReader` adapter over the dedicated mode-dispatch
 * journal (`~/.claudeclaw/journal/mode_dispatch.jsonl`), written by the daemon's
 * `recordModeDispatch`. Each `{ ts, mode, matched_keyword, reclassified }` line
 * maps to the `{ type:"mode_dispatched", mode, keyword, reclassified, ts }`
 * shape `collectObservations` filters on. The subject's default reader is
 * `() => []` (never wired), which is the direct cause of its obs=0.
 */
export function makeModeDispatchReader(
  logPath: string = DEFAULT_MODE_DISPATCH_LOG,
): (since: Date) => Array<Record<string, unknown>> {
  const source = expandHome(logPath);
  return (since: Date) => {
    const out: Array<Record<string, unknown>> = [];
    for (const entry of readJsonlSince(source, since)) {
      const ts = entry.ts;
      if (ts) {
        const tsDate = new Date(ts as string | number);
        if (!Number.isNaN(tsDate.getTime()) && tsDate < since) continue;
      }
      out.push({
        type: "mode_dispatched",
        mode: String(entry.mode ?? "unknown"),
        keyword: String(entry.matched_keyword ?? ""),
        reclassified: entry.reclassified === true,
        ts: entry.ts,
      });
    }
    return out;
  };
}

/** Shape of HookSubject's HookLogEntry (kept structural — the subject's interface
 * is internal; this matches it field-for-field). */
interface HookLogEntryShape {
  hook: string;
  exitCode: number;
  durationMs: number;
  eventType: string;
  timestamp: Date;
}

/**
 * `HookSubject.logReader` adapter. The subject's default reader only scans
 * `*.log` files, but the canonical exec-logger sink is `exec-log.jsonl` (written
 * by `~/.claude/hooks/exec-log.sh`), so collectObservations read 0 entries → 0
 * obs even with a 48KB log present. This reads `exec-log.jsonl` AND any legacy
 * `*.log` files in the hooks dir, mapping `{ ts, hook, exit_code, duration_ms,
 * event }` to the HookLogEntry shape and filtering by `since`.
 */
export function hookExecReader(dir: string, since: Date): HookLogEntryShape[] {
  const hooksDir = expandHome(dir);
  if (!existsSync(hooksDir)) return [];
  let files: string[];
  try {
    files = readdirSync(hooksDir).filter((f) => f === "exec-log.jsonl" || f.endsWith(".log"));
  } catch {
    return [];
  }
  const out: HookLogEntryShape[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(join(hooksDir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const o = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof o !== "object" || o === null) continue;
        const tsRaw = o.ts as string | number | undefined;
        const ts = tsRaw ? new Date(tsRaw) : new Date();
        if (Number.isNaN(ts.getTime()) || ts < since) continue;
        out.push({
          hook: (o.hook as string) ?? f.replace(/\.(jsonl|log)$/, ""),
          exitCode: Number(o.exit_code ?? 0),
          durationMs: Number(o.duration_ms ?? 0),
          eventType: (o.event as string) ?? "unknown",
          timestamp: ts,
        });
      } catch {
        /* skip malformed line */
      }
    }
  }
  return out;
}

/**
 * `CronSubject.journalRunner` adapter over the crontab **log files**.
 *
 * The scheduled tuner/wisecron jobs are POSIX crontab entries that redirect
 * stdout/stderr to `~/agent/logs/*.log` — they are NOT systemd units, so the
 * subject's default `journalctl --user -u 'wisecron-*.service'` runner errors
 * with "No data available" and collectObservations reads 0 entries (producer
 * not found). This reader points the same seam at the real source.
 *
 * Each log file maps to one cron "unit" (`<basename>` without `.log`). Lines
 * are classified by deterministic markers into per-run terminal entries, then
 * re-serialised as journalctl JSON lines so the subject's existing
 * `parseJournalJsonLines` + `aggregateHealth` path is reused unchanged:
 *   - failure marker  → `EXIT_STATUS:"1"` (hard run failure)
 *   - success marker  → `EXIT_STATUS:"0"` (clean run completion)
 * `__REALTIME_TIMESTAMP` is the file's mtime (the logs carry no per-line
 * timestamps); a file whose mtime predates `since` is skipped wholesale.
 *
 * Marker sets are intentionally narrow to avoid the tuner's own diagnostic
 * vocabulary (`*_failure_rate` metric names, the `journalctl runner failed`
 * self-report) registering as job failures.
 */
const CRON_FAILURE_MARKER =
  /error: Module not found|Traceback \(most recent call last\)|\bexited [1-9]\d*\b|❌|command not found|No such file or directory/;
const CRON_SUCCESS_MARKER = /^Proposed: \d+|✅|No matured outcomes|wisecron cron-run: \d+ proposal/;
// Tuner self-diagnostic lines that contain failure-adjacent words but are NOT
// job failures — excluded so the cron subject never flags itself.
const CRON_FALSE_POSITIVE = /_rate'|runner failed|fitness: active metric|health: producer_found/;

export interface CronLogRunnerOpts {
  /** Directory holding the crontab logs. Default `~/agent/logs`. */
  logDir?: string;
  /**
   * Selects which files in `logDir` are cron units. Default: `tuner-skills.log`
   * plus every `wisecron-*.log`.
   */
  fileFilter?: (name: string) => boolean;
}

const defaultCronLogFilter = (name: string): boolean =>
  name === "tuner-skills.log" || (name.startsWith("wisecron-") && name.endsWith(".log"));

export function makeCronLogRunner(
  opts: CronLogRunnerOpts = {},
): (args: string[]) => Promise<string> {
  const logDir = expandHome(opts.logDir ?? "~/agent/logs");
  const fileFilter = opts.fileFilter ?? defaultCronLogFilter;
  return async (args: string[]) => {
    // The subject embeds the window as `--since <ISO>` in the journalctl args.
    let since: Date | null = null;
    const i = args.indexOf("--since");
    if (i >= 0 && args[i + 1]) {
      const d = new Date(args[i + 1] as string);
      if (!Number.isNaN(d.getTime())) since = d;
    }

    if (!existsSync(logDir)) return "";
    let files: string[];
    try {
      files = readdirSync(logDir).filter(fileFilter);
    } catch {
      return "";
    }

    const lines: string[] = [];
    for (const f of files) {
      const path = join(logDir, f);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      // The whole file shares the mtime timestamp; skip it if the last write
      // predates the window (the job has not run inside `since`).
      if (since && mtimeMs < since.getTime()) continue;

      let content: string;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        continue;
      }

      const unit = f.replace(/\.log$/, "");
      const tsUsec = String(Math.floor(mtimeMs * 1000));
      for (const raw of content.split("\n")) {
        const line = raw.trim();
        if (!line || CRON_FALSE_POSITIVE.test(line)) continue;
        let exitStatus: string | null = null;
        if (CRON_FAILURE_MARKER.test(line)) exitStatus = "1";
        else if (CRON_SUCCESS_MARKER.test(line)) exitStatus = "0";
        if (exitStatus === null) continue;
        lines.push(
          JSON.stringify({
            _SYSTEMD_USER_UNIT: unit,
            __REALTIME_TIMESTAMP: tsUsec,
            EXIT_STATUS: exitStatus,
            MESSAGE: line.slice(0, 200),
          }),
        );
      }
    }
    return lines.join("\n");
  };
}
