import { z } from "zod";
import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PluginTool } from "../../mcp-bridge.js";

interface Check {
  label: string;
  ok: boolean;
  detail?: string;
}

export function makeDoctorTool(): PluginTool {
  return {
    name: "tuner_doctor",
    description: "Detect environment and check all skills-tuner dependencies.",
    schema: z.object({}).strict(),
    handler: async () => {
      const home = homedir();
      const checks: Check[] = [];
      let allPassed = true;

      function check(label: string, ok: boolean, detail?: string) {
        checks.push({ label, ok, ...(detail !== undefined ? { detail } : {}) });
        if (!ok) allPassed = false;
      }

      const configPath = join(home, ".config", "tuner", "config.yaml");
      const cfgExists = existsSync(configPath);
      check("Config file exists", cfgExists, configPath);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let config: any = null;
      if (cfgExists) {
        try {
          const { loadConfig } = await import("../../../skills-tuner/core/config.js");
          config = loadConfig(configPath);
          check("Config parses", true);
        } catch (e) {
          check("Config parses", false, e instanceof Error ? e.message : String(e));
        }
      }

      const gitRepo = config?.storage?.git_repo as string | undefined;
      if (gitRepo) {
        const repoExists = existsSync(gitRepo);
        check("storage.git_repo exists", repoExists, gitRepo);
        if (repoExists) check("storage.git_repo is a git repo", existsSync(join(gitRepo, ".git")));
      } else {
        check("storage.git_repo configured", false, "not set in config");
      }

      const secretPath = join(home, ".config", "tuner", ".secret");
      const secretExists = existsSync(secretPath);
      check("Secret file exists", secretExists, secretPath);
      if (secretExists) {
        const st = statSync(secretPath);
        check("Secret is 32 bytes", st.size === 32, `${st.size} bytes`);
        check("Secret perms are 0600", (st.mode & 0o777) === 0o600);
      }

      const projectsDir = join(home, ".claude", "projects");
      if (existsSync(projectsDir)) {
        const jsonlFiles = readdirSync(projectsDir, { recursive: true }).filter(
          (f): f is string => typeof f === "string" && f.endsWith(".jsonl"),
        );
        check("Session JSONL files found", jsonlFiles.length > 0, `${jsonlFiles.length} files`);
      } else {
        check("~/.claude/projects exists", false);
      }

      if (config?.subjects) {
        for (const [name, subj] of Object.entries(config.subjects as Record<string, unknown>)) {
          if (!(subj as Record<string, unknown>)?.enabled) continue;
          const dirs = ((subj as Record<string, unknown>).scan_dirs as string[] | undefined) ?? [];
          for (const d of dirs) {
            const expanded = d.replace("~", home);
            check(`Subject ${name} scan_dir exists`, existsSync(expanded), expanded);
          }
        }
      }

      return { checks, all_passed: allPassed };
    },
  };
}
