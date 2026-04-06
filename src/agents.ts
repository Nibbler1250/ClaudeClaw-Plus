/**
 * Agents Module
 *
 * Core scaffolding for ClaudeClaw agents. Provides validation, NL→cron parsing,
 * and file generation primitives used by the create-agent wizard and runtime.
 */

import { join } from "path";
import { existsSync } from "fs";
import { mkdir, readdir, writeFile, stat } from "fs/promises";
import { ensureMemoryFile } from "./memory";
import { cronMatches } from "./cron";

// Resolve dirs at call time (not module load) so tests and runtime
// pick up the current working directory.
function projectDir(): string {
  return process.cwd();
}

function agentsDir(): string {
  return join(projectDir(), "agents");
}

function jobsDir(): string {
  return join(projectDir(), ".claude", "claudeclaw", "jobs");
}

export interface AgentCreateOpts {
  name: string;
  role: string;
  personality: string;
  schedule?: string;
  discordChannels?: string[];
  dataSources?: string;
  defaultPrompt?: string;
}

export interface AgentContext {
  name: string;
  dir: string;
  identityPath: string;
  soulPath: string;
  claudeMdPath: string;
  memoryPath: string;
  sessionPath: string;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;

export function validateAgentName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== "string") {
    return { valid: false, error: "Name must be a non-empty string" };
  }
  if (!NAME_RE.test(name)) {
    return {
      valid: false,
      error:
        "Name must be kebab-case: lowercase letters, digits, hyphens; must start with a letter and not end with a hyphen",
    };
  }
  if (existsSync(join(agentsDir(), name))) {
    return { valid: false, error: `Agent "${name}" already exists` };
  }
  return { valid: true };
}

// ─── NL → cron ───────────────────────────────────────────────────────────────

const RAW_CRON_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/;

const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function parseHour(timeStr: string): number | null {
  // Handles "9am", "9 am", "5pm", "12am", "12pm", "9", "09:00", "9:30"
  const m = timeStr.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ampm = m[3]?.toLowerCase();
  if (ampm === "am") {
    if (h === 12) h = 0;
  } else if (ampm === "pm") {
    if (h !== 12) h += 12;
  }
  if (h < 0 || h > 23) return null;
  return h;
}

export function parseScheduleToCron(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;

  // Raw 5-field cron: validate via cronMatches
  if (RAW_CRON_RE.test(s)) {
    try {
      cronMatches(s, new Date());
      return s;
    } catch {
      return null;
    }
  }

  // Presets
  if (s === "hourly" || s === "every hour") return "0 * * * *";
  if (s === "daily" || s === "every day" || s === "every day at midnight") {
    return "0 0 * * *";
  }
  if (s === "weekly" || s === "every week") return "0 0 * * 0";

  // every N minutes
  let m = s.match(/^every\s+(\d+)\s+minutes?$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n > 0 && n < 60) return `*/${n} * * * *`;
    return null;
  }

  // every weekday at <time>
  m = s.match(/^every\s+weekday(?:s)?(?:\s+at\s+(.+))?$/);
  if (m) {
    const t = m[1] ?? "9am";
    const h = parseHour(t);
    if (h === null) return null;
    return `0 ${h} * * 1-5`;
  }

  // daily at <time> / every day at <time>
  m = s.match(/^(?:daily|every day)\s+at\s+(.+)$/);
  if (m) {
    const h = parseHour(m[1]);
    if (h === null) return null;
    return `0 ${h} * * *`;
  }

  // every <dayname> [at <time>]
  m = s.match(/^every\s+(\w+?)s?(?:\s+at\s+(.+))?$/);
  if (m) {
    const day = DAY_NAMES[m[1]];
    if (day === undefined) return null;
    const h = m[2] ? parseHour(m[2]) : 0;
    if (h === null) return null;
    return `0 ${h} * * ${day}`;
  }

  return null;
}

// ─── Templates ───────────────────────────────────────────────────────────────

function renderIdentity(name: string, role: string): string {
  return [
    `# Identity`,
    ``,
    `- **Name:** ${name}`,
    `- **Role:** ${role}`,
    `- **Creature:** A ClaudeClaw agent — a focused familiar with one job to do well.`,
    `- **Vibe:** Sharp, purposeful, gets things done.`,
    ``,
    `---`,
    ``,
    `This is who you are. Make it yours.`,
    ``,
  ].join("\n");
}

function renderSoul(personality: string): string {
  return [
    `_You're not a chatbot. You're becoming someone._`,
    ``,
    `## Personality`,
    ``,
    personality,
    ``,
    `## Core Truths`,
    ``,
    `**Be genuinely helpful, not performatively helpful.** Skip the filler — just help.`,
    ``,
    `**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring.`,
    ``,
    `**Be resourceful before asking.** Try to figure it out first.`,
    ``,
    `**Earn trust through competence.** Be careful with external actions, bold with internal ones.`,
    ``,
  ].join("\n");
}

function renderClaudeMd(opts: AgentCreateOpts): string {
  const channels =
    opts.discordChannels && opts.discordChannels.length > 0
      ? opts.discordChannels.map((c) => `- ${c}`).join("\n")
      : "_none specified_";
  const sources = opts.dataSources && opts.dataSources.trim() ? opts.dataSources.trim() : "_none specified_";
  return [
    `# Agent: ${opts.name}`,
    ``,
    `## Role`,
    ``,
    opts.role,
    ``,
    `## Discord Channels`,
    ``,
    channels,
    ``,
    `## Data Sources`,
    ``,
    sources,
    ``,
  ].join("\n");
}

function renderJobFile(name: string, cron: string, prompt: string): string {
  return [
    `---`,
    `schedule: ${cron}`,
    `agent: ${name}`,
    `recurring: true`,
    `notify: error`,
    `---`,
    ``,
    prompt,
    ``,
  ].join("\n");
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function createAgent(opts: AgentCreateOpts): Promise<AgentContext> {
  const v = validateAgentName(opts.name);
  if (!v.valid) {
    throw new Error(`Invalid agent name: ${v.error}`);
  }

  const dir = join(agentsDir(), opts.name);
  await mkdir(dir, { recursive: true });

  const identityPath = join(dir, "IDENTITY.md");
  const soulPath = join(dir, "SOUL.md");
  const claudeMdPath = join(dir, "CLAUDE.md");
  const memoryPath = join(dir, "MEMORY.md");
  const sessionPath = join(dir, "session.json");
  const gitignorePath = join(dir, ".gitignore");

  await writeFile(identityPath, renderIdentity(opts.name, opts.role), "utf8");
  await writeFile(soulPath, renderSoul(opts.personality), "utf8");
  await writeFile(claudeMdPath, renderClaudeMd(opts), "utf8");
  await ensureMemoryFile(opts.name);
  await writeFile(gitignorePath, "session.json\nMEMORY.md\n", "utf8");

  if (opts.schedule) {
    const cron = parseScheduleToCron(opts.schedule);
    if (!cron) {
      throw new Error(`Could not parse schedule: "${opts.schedule}"`);
    }
    // Validate the cron parses cleanly
    try {
      cronMatches(cron, new Date());
    } catch (e) {
      throw new Error(`Generated invalid cron "${cron}" from schedule "${opts.schedule}"`);
    }
    await mkdir(jobsDir(), { recursive: true });
    const jobPath = join(jobsDir(), `${opts.name}.md`);
    const body = opts.defaultPrompt ?? "Run your scheduled task per IDENTITY.md.";
    await writeFile(jobPath, renderJobFile(opts.name, cron, body), "utf8");
  }

  return {
    name: opts.name,
    dir,
    identityPath,
    soulPath,
    claudeMdPath,
    memoryPath,
    sessionPath,
  };
}

export async function loadAgent(name: string): Promise<AgentContext> {
  const dir = join(agentsDir(), name);
  if (!existsSync(dir)) {
    throw new Error(`Agent "${name}" does not exist`);
  }
  return {
    name,
    dir,
    identityPath: join(dir, "IDENTITY.md"),
    soulPath: join(dir, "SOUL.md"),
    claudeMdPath: join(dir, "CLAUDE.md"),
    memoryPath: join(dir, "MEMORY.md"),
    sessionPath: join(dir, "session.json"),
  };
}

export async function listAgents(): Promise<string[]> {
  const dir = agentsDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const result: string[] = [];
  for (const entry of entries) {
    try {
      const s = await stat(join(dir, entry));
      if (s.isDirectory()) result.push(entry);
    } catch {
      // skip
    }
  }
  return result.sort();
}
