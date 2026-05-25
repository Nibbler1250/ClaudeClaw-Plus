/**
 * UI service: exposes the observability hub's read-only data layer to the web UI.
 *
 * Mirrors the self-contained service pattern (`usage.ts`, `logs.ts`): it resolves
 * its own sources from the reference-host defaults and builds an
 * `ObservabilityReader` once, lazily. The route handlers in `server.ts` call the
 * two functions below — there is no bus/daemon dependency to inject.
 *
 * READ-ONLY by construction (the read half of the outcome loop):
 *  - The universal page comes from the `mcp.tool_call` audit log + `session_cost`
 *    (the reader only `query()`s, never writes).
 *  - The tuner's specialized page joins the proposals ledger (`proposals.jsonl`,
 *    append-only — we only `readAll()`) to the outcomes table. We open
 *    `wisecron.db` with a dedicated `{ readonly: true }` handle rather than via
 *    `WisecronStateDB` (whose constructor runs `CREATE TABLE`/PRAGMA — a write)
 *    so this tab can never mutate or create agent/config state. Missing sources
 *    degrade gracefully (no manifest / empty panels), never throw.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ObservabilityReader,
  type PluginPage,
  type PluginSummary,
} from "../../observability/reader.js";
import { DEFAULT_TOOL_CALL_LOG } from "../../observability/tool-call-sink.js";
import {
  buildHostTelemetryProvider,
  type CompositeTelemetryProvider,
} from "../../tuner/wisecron/host-telemetry-provider.js";
import { DEFAULT_PROPOSALS_PATH, ProposalsStore } from "../../skills-tuner/storage/proposals.js";
import type { TunerViewSources } from "../../tuner/wisecron/tuner-view-provider.js";
import type { OutcomeRow } from "../../tuner/wisecron/state-db.js";

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** Reference-host defaults (match `serve.ts` / wisecron settings defaults). */
const COST_DB_PATH = join(homedir(), "agent", "data", "costs.db");
const WISECRON_DB_PATH = join(homedir(), ".config", "tuner", "wisecron.db");

/**
 * The tuner's outcomes table, read through a strictly read-only SQLite handle.
 * Returns `() => []` when `wisecron.db` is absent so the timeline still renders
 * the applied proposals (with blank delta/verdict) — graceful degradation.
 */
function readonlyOutcomesFor(dbPath: string): TunerViewSources["outcomesFor"] {
  if (!existsSync(dbPath)) return () => [];
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return () => [];
  }
  const handle = db;
  return (proposalId: string): OutcomeRow[] => {
    try {
      return handle
        .prepare("SELECT * FROM outcomes WHERE proposal_id = ? ORDER BY metric ASC")
        .all(proposalId) as OutcomeRow[];
    } catch {
      // Table not present yet (db created but never migrated) → no outcomes.
      return [];
    }
  };
}

let readerSingleton: { reader: ObservabilityReader; provider: CompositeTelemetryProvider } | null =
  null;

/**
 * Build the reader once. The composite provider doubles as the view-manifest
 * source (it implements both interfaces), so the reader discovers the tuner's
 * specialized page through the same object that serves the universal metrics.
 */
function getReader(): { reader: ObservabilityReader; provider: CompositeTelemetryProvider } {
  if (readerSingleton) return readerSingleton;

  const mcpToolCallLog = expandHome(DEFAULT_TOOL_CALL_LOG);
  const proposals = new ProposalsStore(expandHome(DEFAULT_PROPOSALS_PATH));
  const tunerView: TunerViewSources = {
    proposals,
    outcomesFor: readonlyOutcomesFor(WISECRON_DB_PATH),
  };

  const provider = buildHostTelemetryProvider({
    costDbPath: COST_DB_PATH,
    mcpToolCallLog,
    tunerView,
  });
  const reader = new ObservabilityReader({ telemetry: provider, manifests: provider });
  readerSingleton = { reader, provider };
  return readerSingleton;
}

/** Test seam: drop the memoized reader so a test can re-resolve sources. */
export function resetObservabilityReader(): void {
  readerSingleton = null;
}

function rangeFromHours(hours: number): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600_000);
  return { start, end };
}

export interface ObservabilityOverview {
  /** Auto-discovered plugins with universal boundary metrics, volume-sorted. */
  plugins: PluginSummary[];
  /** Plugins that declared a view-manifest (→ a specialized page). */
  specializedPlugins: string[];
  rangeHours: number;
  generatedAt: string;
}

// Short cache so dashboard polling doesn't re-parse the audit log every tick;
// mirrors usage.ts. Keyed by rangeHours since metrics depend on the window.
const overviewCache = new Map<number, { data: ObservabilityOverview; ts: number }>();
const OVERVIEW_TTL_MS = 15_000;

/** The plugin list + universal metrics for the hub landing view. */
export async function getObservabilityOverview(rangeHours = 168): Promise<ObservabilityOverview> {
  const cached = overviewCache.get(rangeHours);
  if (cached && Date.now() - cached.ts < OVERVIEW_TTL_MS) return cached.data;

  const { reader } = getReader();
  const plugins = await reader.plugins(rangeFromHours(rangeHours));
  const specializedPlugins = reader.manifestList().map((m) => m.plugin);
  const data: ObservabilityOverview = {
    plugins,
    specializedPlugins,
    rangeHours,
    generatedAt: new Date().toISOString(),
  };
  overviewCache.set(rangeHours, { data, ts: Date.now() });
  return data;
}

/**
 * A single plugin's page: universal summary always, plus its view-manifest and
 * filled panels when it declared one (otherwise `manifest: null` → universal
 * page only on the client).
 */
export async function getObservabilityPluginPage(
  plugin: string,
  rangeHours = 168,
): Promise<PluginPage> {
  const { reader } = getReader();
  return reader.pageFor(plugin, rangeFromHours(rangeHours));
}
