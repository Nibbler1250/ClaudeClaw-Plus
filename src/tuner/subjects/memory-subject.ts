import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { BaseSubject } from "../../skills-tuner/subjects/base.js";
import { sanitizeObservationContent } from "../../skills-tuner/core/security.js";
import type { LLMClient } from "../../skills-tuner/core/llm.js";
import type {
  Cluster,
  Observation,
  Patch,
  Proposal,
  UnsignedProposal,
  ValidationResult,
} from "../../skills-tuner/core/types.js";
import type { RevertibleSubject } from "../wisecron/types.js";
import { renderDiff } from "../wisecron/render-diff.js";
import type { DateRange, Metric, TelemetryProvider } from "../../skills-tuner/core/telemetry.js";
import { ARTIFACT_SOURCE } from "../../skills-tuner/core/telemetry.js";
import { median } from "../../skills-tuner/core/aggregate.js";

/** Derive Claude Code's per-user memory index location.
 * Mirrors Claude Code's pattern: `~/.claude/projects/-home-<basename>/memory/MEMORY.md`.
 */
function defaultMemoryIndex(): string {
  const home = homedir();
  const slug = `-home-${basename(home)}`;
  return `${home}/.claude/projects/${slug}/memory/MEMORY.md`;
}

const MAX_INDEX_LINES = 200;
const HEADER = "# Memory Index";
// `- [Title](file.md) — hook` shape — em-dash or ASCII hyphen separator.
const ENTRY_RE = /^- \[([^\]]+)\]\(([^)]+\.md)\)(?:\s+[—-]\s+(.+))?$/;

interface MemoryEntry {
  raw: string;
  title: string;
  file: string;
  hook: string | null;
}

/**
 * MemorySubject — wisecron-managed MEMORY.md index tuner (LOW).
 *
 * What it tunes: MEMORY.md (auto-memory index) at
 * `~/.claude/projects/-home-<user>/memory/MEMORY.md`. Detects:
 *  - duplicate entries (same slug or near-duplicate description)
 *  - dead entries (referenced .md file no longer exists)
 *  - stale ordering (most-referenced entries should be on top)
 *  - bloated index (>200 lines per CLAUDE.md spec)
 *
 * Telemetry: count of memory file reads per UserPromptSubmit hook log.
 * Risk class: LOW — index reorder/dedup, no content removed from per-file
 * memory bodies (only the index pointers shift).
 */
export interface MemorySubjectConfig {
  llm?: LLMClient;
  /** Path to MEMORY.md index. */
  memoryIndex?: string;
  /** UserPromptSubmit hook log for read-frequency telemetry. */
  hookLog?: string;
}

export class MemorySubject extends BaseSubject implements RevertibleSubject {
  readonly name = "memory";
  readonly risk_tier = "low" as const;
  readonly auto_merge_default = true;
  readonly supports_creation = false;

  private readonly llm?: LLMClient;
  private readonly memoryIndex: string;
  private readonly hookLog?: string;

  constructor(opts: MemorySubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    this.memoryIndex = opts.memoryIndex ?? defaultMemoryIndex();
    this.hookLog = opts.hookLog;
  }

  async collectObservations(_since: Date): Promise<Observation[]> {
    if (!existsSync(this.memoryIndex)) return [];
    const content = readFileSync(this.memoryIndex, "utf8");
    const entries = parseEntries(content);
    if (entries.length === 0) return [];

    const memoryDir = dirname(this.memoryIndex);
    const observations: Observation[] = [];
    const now = new Date();

    const slugCounts = new Map<string, number>();
    for (const e of entries) {
      const slug = e.file.replace(/\.md$/, "");
      slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
    }

    for (const e of entries) {
      const slug = e.file.replace(/\.md$/, "");
      const refPath = resolve(memoryDir, e.file);
      const dead = !existsSync(refPath);
      const duplicate = (slugCounts.get(slug) ?? 0) > 1;
      if (!dead && !duplicate) continue;

      const issues: string[] = [];
      if (dead) issues.push("dead_ref");
      if (duplicate) issues.push("duplicate_slug");

      observations.push({
        session_id: `memory-${slug}-${now.getTime()}`,
        observed_at: now,
        signal_type: dead ? "orphan" : "repeated_trigger",
        verbatim: sanitizeObservationContent(
          JSON.stringify({
            slug,
            file: e.file,
            title: e.title,
            issues,
          }),
          500,
        ),
        metadata: {
          subject: "memory",
          slug,
          file: e.file,
          dead,
          duplicate,
        },
      });
    }

    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length < 2) return [];
    return [
      {
        id: "memory-index-cleanup",
        subject: "memory",
        observations,
        frequency: observations.length,
        success_rate: 0.5,
        sentiment: "neutral",
        subjects_touched: ["memory"],
      },
    ];
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    if (!existsSync(this.memoryIndex)) {
      throw new Error("memory-subject.proposeChange: index missing");
    }
    const current = readFileSync(this.memoryIndex, "utf8");
    const dedupDead = applyStrategy(current, this.memoryIndex, "dedup-dead");
    const dedupReorder = applyStrategy(current, this.memoryIndex, "dedup-reorder");
    const dedupGroup = applyStrategy(current, this.memoryIndex, "dedup-group");

    // Emit unified diffs (≤2KB each) so the three alternatives stay visually
    // distinct in adapter surfaces. apply() re-runs the strategy against the
    // live file rather than blindly writing what's in diff_or_content.
    return {
      id: Date.now(),
      cluster_id: cluster.id,
      subject: "memory",
      kind: "patch",
      target_path: this.memoryIndex,
      alternatives: [
        {
          id: "dedup-dead",
          label: "Dedup + remove dead refs",
          diff_or_content: renderDiff(current, dedupDead, {
            fromLabel: "MEMORY.md",
            toLabel: "MEMORY.md (dedup-dead)",
          }),
          tradeoff: "Smallest diff, removes only confirmed-dead pointers.",
        },
        {
          id: "dedup-reorder",
          label: "Dedup + reorder alphabetically",
          diff_or_content: renderDiff(current, dedupReorder, {
            fromLabel: "MEMORY.md",
            toLabel: "MEMORY.md (dedup-reorder)",
          }),
          tradeoff: "Easier visual scan; reorder churn in git blame.",
        },
        {
          id: "dedup-group",
          label: "Dedup + group by name prefix",
          diff_or_content: renderDiff(current, dedupGroup, {
            fromLabel: "MEMORY.md",
            toLabel: "MEMORY.md (dedup-group)",
          }),
          tradeoff: "Groups feedback_/project_/user_ entries together; loses chronological order.",
        },
      ],
      pattern_signature: `memory:dedup:${parseEntries(current).length}`,
      created_at: new Date(),
    };
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    if (proposal.target_path !== this.memoryIndex) {
      throw new Error(
        `memory-subject.apply: target_path mismatch (${proposal.target_path} vs ${this.memoryIndex})`,
      );
    }
    const alt = proposal.alternatives.find((a) => a.id === alternativeId);
    if (!alt) throw new Error(`memory-subject.apply: alternative ${alternativeId} not found`);
    if (!isKnownStrategy(alternativeId)) {
      throw new Error(`memory-subject.apply: unknown strategy '${alternativeId}'`);
    }

    const current = existsSync(this.memoryIndex) ? readFileSync(this.memoryIndex, "utf8") : "";
    const newContent = applyStrategy(current, this.memoryIndex, alternativeId);

    if (existsSync(this.memoryIndex)) {
      copyFileSync(this.memoryIndex, `${this.memoryIndex}.bak`);
    }
    writeFileSync(this.memoryIndex, newContent, "utf8");

    return {
      target_path: this.memoryIndex,
      kind: "patch",
      applied_content: newContent,
    };
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    const content = patch.applied_content;
    if (!content.startsWith(HEADER)) {
      return { valid: false, reason: `missing "${HEADER}" header` };
    }
    const lines = content.split("\n");
    if (lines.length > MAX_INDEX_LINES) {
      return { valid: false, reason: `index exceeds ${MAX_INDEX_LINES} lines (${lines.length})` };
    }
    const memoryDir = dirname(this.memoryIndex);
    for (const line of lines) {
      if (!line.startsWith("- ")) continue;
      const m = line.match(ENTRY_RE);
      if (!m) return { valid: false, reason: `malformed entry: ${line}` };
      const file = m[2]!;
      if (file.includes("..") || file.startsWith("/")) {
        return { valid: false, reason: `entry references file outside memory dir: ${file}` };
      }
      const resolved = resolve(memoryDir, file);
      if (!resolved.startsWith(`${memoryDir}/`) && resolved !== memoryDir) {
        return { valid: false, reason: `entry references file outside memory dir: ${file}` };
      }
    }
    return { valid: true };
  }

  async revert(inversePatch: Patch): Promise<void> {
    if (inversePatch.target_path !== this.memoryIndex) {
      throw new Error(`memory-subject.revert: target_path mismatch`);
    }
    writeFileSync(this.memoryIndex, inversePatch.applied_content, "utf8");
  }

  /**
   * OutcomeLoop fitness for the memory subject (LOW risk).
   *
   * Target — `memory_median_reads_per_entry` (Tier 1, `memory_access`): the
   * typical index entry's read frequency (median per-entry access count over the
   * window). Higher is better — a well-curated index gets used. Median, so one
   * hot entry can't dominate. The gameable shortcut is to delete entries to lift
   * the per-entry median, so it is guarded by `memory_index_entry_count`
   * (Tier 1b artifact, higher_is_better). `memory_index_defect_count`
   * (Tier 1b artifact): always-on scan for dead-ref + duplicate-slug entries.
   */
  fitnessSignals(): Metric[] {
    return [
      {
        name: "memory_median_reads_per_entry",
        source: "memory_access",
        kind: "verifiable",
        direction: "higher_is_better",
        windowDays: 7,
        guardrails: ["memory_index_entry_count"],
      },
      {
        name: "memory_index_defect_count",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "lower_is_better",
        windowDays: 1,
      },
      {
        name: "memory_index_entry_count",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "higher_is_better",
        windowDays: 7,
      },
    ];
  }

  /**
   * Telemetry read ONLY via `provider.query("memory_access", …)`; aggregated as
   * a median of per-entry read counts (outlier-robust). Artifact metrics parse
   * the managed index and are omitted only when the index file is absent.
   */
  async measureFitness(
    range: DateRange,
    provider: TelemetryProvider,
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};

    // ── Tier 1: memory_access stream (one sample per read, labels.file) ─────
    const samples = await provider.query("memory_access", range);
    if (samples.length > 0) {
      const perFile = new Map<string, number>();
      for (const s of samples) {
        const file = s.labels?.file ?? "unknown";
        perFile.set(file, (perFile.get(file) ?? 0) + 1);
      }
      out.memory_median_reads_per_entry = median([...perFile.values()]);
    }

    // ── Tier 1b: artifact scan of the index ─────────────────────────────────
    const scan = this.scanIndex();
    if (scan !== null) {
      out.memory_index_entry_count = scan.entries;
      out.memory_index_defect_count = scan.defects;
    }

    return out;
  }

  /**
   * Scan MEMORY.md: defects = entries whose referenced file is missing (dead) +
   * duplicate-slug entries. Returns null when the index file is absent.
   */
  private scanIndex(): { entries: number; defects: number } | null {
    if (!existsSync(this.memoryIndex)) return null;
    let content: string;
    try {
      content = readFileSync(this.memoryIndex, "utf8");
    } catch {
      return null;
    }
    const entries = parseEntries(content);
    const memoryDir = dirname(this.memoryIndex);
    const slugCounts = new Map<string, number>();
    for (const e of entries) {
      const slug = e.file.replace(/\.md$/, "");
      slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
    }
    let defects = 0;
    for (const e of entries) {
      const slug = e.file.replace(/\.md$/, "");
      if (!existsSync(resolve(memoryDir, e.file))) defects += 1;
      else if ((slugCounts.get(slug) ?? 0) > 1) defects += 1;
    }
    return { entries: entries.length, defects };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseEntries(content: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(ENTRY_RE);
    if (!m) continue;
    out.push({
      raw: line,
      title: m[1]!,
      file: m[2]!,
      hook: m[3] ?? null,
    });
  }
  return out;
}

function dedupe(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>();
  const out: MemoryEntry[] = [];
  for (const e of entries) {
    if (seen.has(e.file)) continue;
    seen.add(e.file);
    out.push(e);
  }
  return out;
}

function renderIndex(entries: MemoryEntry[]): string {
  const lines: string[] = [HEADER, ""];
  for (const e of entries) {
    if (e.hook) lines.push(`- [${e.title}](${e.file}) — ${e.hook}`);
    else lines.push(`- [${e.title}](${e.file})`);
  }
  return `${lines.join("\n")}\n`;
}

type Strategy = "dedup-dead" | "dedup-reorder" | "dedup-group";

function isKnownStrategy(s: string): s is Strategy {
  return s === "dedup-dead" || s === "dedup-reorder" || s === "dedup-group";
}

function applyStrategy(current: string, indexPath: string, strategy: Strategy): string {
  const entries = parseEntries(current);
  const memoryDir = dirname(indexPath);
  const live = entries.filter((e) => existsSync(resolve(memoryDir, e.file)));
  const deduped = dedupe(live);

  switch (strategy) {
    case "dedup-dead":
      return renderIndex(deduped);
    case "dedup-reorder":
      return renderIndex([...deduped].sort((a, b) => a.title.localeCompare(b.title)));
    case "dedup-group": {
      // Group by leading slug-prefix (e.g. `feedback_`, `project_`, `user_`);
      // entries without an underscore prefix go to a final 'misc' bucket.
      const groups = new Map<string, MemoryEntry[]>();
      for (const e of deduped) {
        const m = e.file.match(/^([a-zA-Z][a-zA-Z0-9]*)_/);
        const key = m ? m[1]! : "misc";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)?.push(e);
      }
      const orderedKeys = [...groups.keys()].sort();
      const out: MemoryEntry[] = [];
      for (const k of orderedKeys) {
        const bucket = groups.get(k)!;
        bucket.sort((a, b) => a.title.localeCompare(b.title));
        out.push(...bucket);
      }
      return renderIndex(out);
    }
  }
}
