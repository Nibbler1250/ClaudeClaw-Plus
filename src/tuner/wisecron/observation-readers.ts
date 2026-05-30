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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { DEFAULT_TOOL_CALL_LOG } from "../../observability/tool-call-sink.js";
import { DEFAULT_MODE_DISPATCH_LOG } from "../../governance/mode-dispatch-journal.js";

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
