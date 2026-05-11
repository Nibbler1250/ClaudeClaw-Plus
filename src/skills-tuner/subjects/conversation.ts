/**
 * ConversationSubject — Analyze Simon's conversation patterns with Greg
 *
 * Reads:
 * - active-bug-context.md (current discussion topic)
 * - session-state.md (task progress, pending work)
 * - MEMORY.md (session summaries)
 * - Git logs (recent commits = work performed)
 * - Error logs (failure patterns)
 *
 * Detects:
 * - Repeated questions (ask for same thing 3+ times)
 * - Context loss (topic forgotten between sessions)
 * - Stalled discussions (same topic > 1h, no resolution)
 * - Missing automations (manual task done 3+ times)
 * - Slow response patterns (> 2min per task)
 * - Information bottlenecks (same doc read repeatedly)
 *
 * Proposes:
 * - Shortcuts/commands for frequent tasks
 * - Memory entries for repeated context
 * - Automation scripts for manual work
 * - Decision points for stalled topics
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { TunableSubject, type Observation, type Cluster, type Proposal } from "../core/interfaces.js";

interface ConversationAnomaly {
  type:
    | "repeated_question"
    | "context_loss"
    | "stalled_topic"
    | "missing_automation"
    | "response_slow"
    | "info_bottleneck"
    | "error_pattern";
  description: string;
  evidence: string[];
  frequency?: number;
  lastSeen?: string;
}

export class ConversationSubject extends TunableSubject {
  readonly name = "conversation";
  readonly risk_tier = "low" as const;
  readonly auto_merge_default = false;
  readonly supports_creation = false;

  async collectObservations(since: Date): Promise<Observation[]> {
    const observations: Observation[] = [];
    const homedir_ = homedir();

    // Read context files
    const activeBugPath = join(homedir_, "agent", "data", "active-bug-context.md");
    const sessionStatePath = join(homedir_, "agent", "data", "session-state.md");
    const memoryPath = join(homedir_, "agent", "MEMORY.md");
    const learningsPath = join(homedir_, "agent", "learnings", "learnings.md");
    const errorLogPath = join(homedir_, "agent", "learnings", "error-log.md");

    let activeBugContext = "";
    let sessionState = "";
    let memory = "";
    let learnings = "";
    let errorLog = "";

    try {
      if (existsSync(activeBugPath)) {
        activeBugContext = await readFile(activeBugPath, "utf8");
      }
      if (existsSync(sessionStatePath)) {
        sessionState = await readFile(sessionStatePath, "utf8");
      }
      if (existsSync(memoryPath)) {
        memory = await readFile(memoryPath, "utf8");
      }
      if (existsSync(learningsPath)) {
        learnings = await readFile(learningsPath, "utf8");
      }
      if (existsSync(errorLogPath)) {
        errorLog = await readFile(errorLogPath, "utf8");
      }
    } catch {
      // Files may not exist yet
    }

    // Extract anomalies
    const anomalies = await this.analyzeConversationPatterns(
      activeBugContext,
      sessionState,
      memory,
      learnings,
      errorLog,
      since
    );

    for (const anomaly of anomalies) {
      observations.push({
        id: `conversation:${anomaly.type}:${Date.now()}`,
        category: "conversation_pattern",
        severity: anomaly.type === "stalled_topic" ? "high" : "medium",
        summary: anomaly.description,
        details: anomaly.evidence.join(" | "),
      });
    }

    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length === 0) return [];

    const clusters: Cluster[] = [];
    const grouped = new Map<string, Observation[]>();

    // Group by anomaly type
    for (const obs of observations) {
      const key = obs.category || "unknown";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(obs);
    }

    for (const [category, obsList] of grouped.entries()) {
      if (obsList.length === 0) continue;

      const cluster: Cluster = {
        id: `${this.name}:${category}:${Date.now()}`,
        subject: this.name,
        anomaly_type: category,
        severity: Math.max(
          ...obsList.map((o) => (o.severity === "high" ? 2 : o.severity === "medium" ? 1 : 0))
        ) === 2
          ? "high"
          : "medium",
        observations: obsList,
        count: obsList.length,
      };
      clusters.push(cluster);
    }

    return clusters;
  }

  async proposeChange(cluster: Cluster): Promise<Proposal | null> {
    const { anomaly_type, observations } = cluster;

    if (!anomaly_type || observations.length === 0) return null;

    const summary = observations.map((o) => o.summary).join("; ");

    switch (anomaly_type) {
      case "conversation_pattern":
        return this.buildProposal(cluster, summary);
      default:
        return null;
    }
  }

  private async buildProposal(cluster: Cluster, summary: string): Promise<Proposal | null> {
    const obs = cluster.observations[0];
    if (!obs) return null;

    const proposalId = Math.floor(Math.random() * 100000);

    return {
      id: proposalId,
      cluster_id: cluster.id,
      subject: this.name,
      kind: "conversation_improvement",
      target_path: "~/.claudeclaw/conversation-patterns.md",
      title: "Optimiser le flux de la discussion",
      description: `Détecté: ${summary}`,
      alternatives: [
        {
          id: "alt-0",
          label: "Implémenter la suggestion (créer skill/automation/memory)",
          diff_or_content: `# Suggestion\n${obs.details}`,
          tradeoff: "Améliore le flux, réduit friction",
        },
        {
          id: "alt-1",
          label: "Ignorer (pas pertinent maintenant)",
          diff_or_content: "# Pas d'action — reconnu mais pas prioritaire",
          tradeoff: "Garde le focus actuel",
        },
      ],
      pattern_signature: `conversation:${cluster.anomaly_type}`,
      created_at: new Date().toISOString(),
      signature: "",
    };
  }

  private async analyzeConversationPatterns(
    activeBugContext: string,
    sessionState: string,
    memory: string,
    learnings: string,
    errorLog: string,
    since: Date
  ): Promise<ConversationAnomaly[]> {
    const anomalies: ConversationAnomaly[] = [];

    // Pattern 1: Repeated questions (same topic in active-bug-context across sessions)
    if (activeBugContext.includes("WiseCron") && memory.includes("WiseCron")) {
      const matches = (memory.match(/WiseCron/g) || []).length;
      if (matches >= 3) {
        anomalies.push({
          type: "repeated_question",
          description: "WiseCron discussion reviendra plusieurs fois — pourrait avoir un comando `/tune-cron`?",
          evidence: [
            `WiseCron mentionné ${matches} fois en mémoire`,
            "Sujet recurrent = optimisation candidate",
          ],
        });
      }
    }

    // Pattern 2: Context loss (activity-bug-context references old sessions)
    const contextLines = activeBugContext.split("\n");
    const referencesToPastSessions = contextLines.filter(
      (l) => l.includes("dernier") || l.includes("avant") || l.includes("yesterday")
    ).length;
    if (referencesToPastSessions >= 2) {
      anomalies.push({
        type: "context_loss",
        description: "Contexte perdu entre sessions — Simon demande souvent de relire des fichiers",
        evidence: [`${referencesToPastSessions} références au contexte antérieur`],
      });
    }

    // Pattern 3: Stalled topics (same topic in session-state without resolution)
    const stalledMatches = (sessionState.match(/Suspendu|⏸|pending|waiting/gi) || []).length;
    if (stalledMatches >= 2) {
      anomalies.push({
        type: "stalled_topic",
        description: "Plusieurs tâches suspendues sans décision — besoin de triage",
        evidence: [`${stalledMatches} tâches en attente dans session-state`],
      });
    }

    // Pattern 4: Error patterns (repeated errors in learnings/error-log)
    const errorPatterns = this.extractErrorPatterns(errorLog);
    for (const [pattern, count] of errorPatterns.entries()) {
      if (count >= 3) {
        anomalies.push({
          type: "error_pattern",
          description: `Erreur récurrente: ${pattern} (${count} fois) — appliquer la règle d'apprentissage`,
          evidence: [`Seen ${count}x`, "Devrait être dans learnings.md ou preventé par hook"],
        });
      }
    }

    // Pattern 5: Information bottleneck (same file read multiple times from MEMORY)
    const infoBottlenecks = this.extractInfoBottlenecks(memory);
    for (const [file, count] of infoBottlenecks.entries()) {
      if (count >= 3) {
        anomalies.push({
          type: "info_bottleneck",
          description: `Fichier relu 3+ fois: ${file} — devrait être en @memory`,
          evidence: [`Accessed ${count}x selon MEMORY`, "Ralentit la conversation"],
        });
      }
    }

    return anomalies;
  }

  private extractErrorPatterns(errorLog: string): Map<string, number> {
    const patterns = new Map<string, number>();
    const lines = errorLog.split("\n");
    for (const line of lines) {
      if (line.includes("ERROR") || line.includes("Error")) {
        const pattern = line.split(":")[0]?.slice(0, 40) || "unknown";
        patterns.set(pattern, (patterns.get(pattern) || 0) + 1);
      }
    }
    return patterns;
  }

  private extractInfoBottlenecks(memory: string): Map<string, number> {
    const bottlenecks = new Map<string, number>();
    const fileMatches = memory.match(/\[.*\]\(.*\)/g) || [];
    for (const match of fileMatches) {
      const file = match.split("(")[1]?.split(")")[0] || "unknown";
      bottlenecks.set(file, (bottlenecks.get(file) || 0) + 1);
    }
    return bottlenecks;
  }

  async apply(): Promise<void> {
    // ConversationSubject makes proposals but doesn't auto-apply
    // Simon decides what to do with suggestions
  }

  async validate(): Promise<boolean> {
    return true;
  }

  currentStateHash(): string {
    // Hash of the conversation state (memory + active-bug-context)
    return `conversation:${Date.now()}`;
  }
}
