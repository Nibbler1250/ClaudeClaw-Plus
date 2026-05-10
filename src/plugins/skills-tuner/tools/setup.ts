import { z } from "zod";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { PluginTool } from "../../mcp-bridge.js";

interface SetupStep {
  step: string;
  ok: boolean;
  path?: string;
  note?: string;
}

export function makeSetupTool(): PluginTool {
  return {
    name: "tuner_setup",
    description: "First-run setup: checks/installs the /tuner skill and default config. Idempotent.",
    schema: z.object({
      dry: z.boolean().optional().describe("If true, only check state without writing anything."),
    }),
    handler: async ({ dry }) => {
      const home = homedir();
      const steps: SetupStep[] = [];
      const configPath = join(home, ".config", "tuner", "config.yaml");

      // Check/install tuner skill
      const skillsDir = join(home, ".claude", "skills");
      const targetSkill = join(skillsDir, "tuner.md");
      const skillExists = existsSync(targetSkill);

      if (skillExists) {
        steps.push({ step: "tuner_skill", ok: true, path: targetSkill, note: "already exists" });
      } else if (!dry) {
        const __dirname = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", "..");
        const candidates = [
          join(__dirname, "templates", "skills", "tuner.md"),
          join(__dirname, "src", "skills-tuner-templates", "tuner.md"),
        ];
        const src = candidates.find((p) => existsSync(p));
        if (src) {
          mkdirSync(skillsDir, { recursive: true });
          copyFileSync(src, targetSkill);
          steps.push({ step: "tuner_skill", ok: true, path: targetSkill, note: "created" });
        } else {
          steps.push({ step: "tuner_skill", ok: false, note: "template not found" });
        }
      } else {
        steps.push({ step: "tuner_skill", ok: false, path: targetSkill, note: "missing (dry run)" });
      }

      // Check/create config
      const configExists = existsSync(configPath);
      if (configExists) {
        steps.push({ step: "config", ok: true, path: configPath, note: "already exists" });
      } else if (!dry) {
        const { writeDefaultConfig } = await import("../../../skills-tuner/core/config.js");
        writeDefaultConfig(configPath);
        steps.push({ step: "config", ok: true, path: configPath, note: "created" });
      } else {
        steps.push({ step: "config", ok: false, path: configPath, note: "missing (dry run)" });
      }

      return { steps, config_path: configPath };
    },
  };
}
