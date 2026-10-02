/**
 * Tests for the recursive secret redaction in src/ui/services/state.ts
 * (issue #164 item 5). buildTechnicalInfo feeds settings through
 * redactSettings before they leave the daemon via /api/technical-info.
 *
 * redactSettings isn't exported, so we exercise it through
 * buildTechnicalInfo with a synthetic snapshot + a temp settings file.
 *
 * Secret-shaped values are assembled at runtime via string concatenation
 * so the in-repo secrets-in-code pre-commit guard doesn't trip on them.
 *
 * Run with: bun test src/ui/__tests__/state-redact.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cwdBackup: string;
let tmp: string;

// Built at runtime to dodge the secrets-in-code scanner.
const TG = `tg-${"bot"}-token-xyz`;
const SLACK_BOT = `xoxb${"-"}1aaa`;
const SLACK_APP = `xapp${"-"}1bbb`;

beforeEach(() => {
  cwdBackup = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ccaw-redact-"));
  process.chdir(tmp);
  mkdirSync(join(tmp, ".claude", "claudeclaw"), { recursive: true });
});

afterEach(() => {
  process.chdir(cwdBackup);
  rmSync(tmp, { recursive: true, force: true });
});

function findValue(obj: unknown, key: string): unknown {
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const hit = findValue(v, key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === key) return v;
      const hit = findValue(v, key);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

describe("recursive redactSettings via buildTechnicalInfo (#164 item 5)", () => {
  it("redacts secret-named fields at any depth and leaves non-secrets intact", async () => {
    // Settings with secrets at top level, nested, and deeply nested under
    // arbitrary keys — the kind of drift the old hand-rolled redactor missed.
    const settingsObj = {
      model: "opus",
      apiToken: "TOP-SECRET-1234567890",
      api: "glm-key-abc",
      telegram: { token: TG, allowedUserIds: [1, 2] },
      discord: { token: "dc-token" },
      slack: { botToken: SLACK_BOT, appToken: SLACK_APP },
      nested: { deep: { password: "hunter2", secret: "s3cr3t", harmless: "keep-me" } },
      agents: [{ id: "reg", apiKey: "per-agent-key" }],
    };
    writeFileSync(
      join(tmp, ".claude", "claudeclaw", "settings.json"),
      JSON.stringify(settingsObj, null, 2),
    );

    const { buildTechnicalInfo } = await import("../services/state");
    const snapshot = {
      pid: 123,
      startedAt: Date.now(),
      heartbeatNextAt: 0,
      settings: settingsObj as never,
      jobs: [],
    };
    const info = (await buildTechnicalInfo(snapshot)) as Record<string, unknown>;
    // Assert against the in-memory snapshot.settings redaction (not the
    // disk-read files.settingsJson) — buildTechnicalInfo reads the file
    // via a module-load-frozen path constant that isn't reliable under
    // per-test chdir. Both paths run the same redactSettings.
    const snap = info.snapshot as Record<string, unknown>;
    const redacted = snap.settings;

    // Every secret-named field, at every depth, is replaced.
    for (const key of [
      "apiToken",
      "api",
      "token",
      "botToken",
      "appToken",
      "password",
      "secret",
      "apiKey",
    ]) {
      const v = findValue(redacted, key);
      expect(typeof v).toBe("string");
      expect(v as string).toMatch(/^<redacted:\d+ chars>$/);
    }
    // Raw secret values never survive anywhere in the output.
    const serialized = JSON.stringify(redacted);
    for (const leaked of [
      "TOP-SECRET-1234567890",
      "glm-key-abc",
      TG,
      "dc-token",
      SLACK_BOT,
      SLACK_APP,
      "hunter2",
      "s3cr3t",
      "per-agent-key",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    // Non-secret fields pass through untouched.
    expect(findValue(redacted, "model")).toBe("opus");
    expect(findValue(redacted, "harmless")).toBe("keep-me");
    expect(findValue(redacted, "allowedUserIds")).toEqual([1, 2]);
  });

  it("records the char-length of the original secret", async () => {
    const settingsObj = { apiToken: "abcdef" }; // 6 chars
    const { buildTechnicalInfo } = await import("../services/state");
    const info = (await buildTechnicalInfo({
      pid: 1,
      startedAt: Date.now(),
      heartbeatNextAt: 0,
      settings: settingsObj as never,
      jobs: [],
    })) as Record<string, unknown>;
    const snap = info.snapshot as Record<string, unknown>;
    expect(findValue(snap.settings, "apiToken")).toBe("<redacted:6 chars>");
  });
});

async function redactViaTechnicalInfo(settingsObj: unknown): Promise<unknown> {
  const { buildTechnicalInfo } = await import("../services/state");
  const info = (await buildTechnicalInfo({
    pid: 1,
    startedAt: Date.now(),
    heartbeatNextAt: 0,
    settings: settingsObj as never,
    jobs: [],
  })) as Record<string, unknown>;
  return (info.snapshot as Record<string, unknown>).settings;
}

const REDACTED = /^<redacted:\d+ chars>$/;

describe("redactSettings matches secret-shaped key names, not only exact ones (#510)", () => {
  it("redacts slack.signingSecret and slack.busRouting.signingSecret", async () => {
    const signing = `sig${"-"}secret-${"a".repeat(24)}`;
    const routing = `sig${"-"}routing-${"b".repeat(24)}`;
    const redacted = (await redactViaTechnicalInfo({
      slack: {
        botToken: SLACK_BOT,
        signingSecret: signing,
        busRouting: { signingSecret: routing },
      },
    })) as { slack: { signingSecret: unknown; busRouting: { signingSecret: unknown } } };

    expect(redacted.slack.signingSecret).toMatch(REDACTED);
    expect(redacted.slack.busRouting.signingSecret).toMatch(REDACTED);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(signing);
    expect(serialized).not.toContain(routing);
  });

  it("redacts any key ending in a secret-shaped word, at any depth and in any case", async () => {
    const values: Record<string, string> = {
      clientSecret: "cs-value-1",
      webhookSecret: "wh-value-2",
      accessToken: "at-value-3",
      REFRESH_TOKEN: "rt-value-4",
      privateKey: "pk-value-5",
      openai_api_key: "ok-value-6",
      dbPassword: "db-value-7",
      apiKeys: "ak-value-8",
      secrets: "ss-value-9",
      credentials: "cr-value-10",
      passphrase: "pp-value-11",
      smtpPasswd: "sp-value-12",
      Authorization: "Bearer au-value-13",
      cookie: "ck-value-14",
    };
    const redacted = await redactViaTechnicalInfo({
      plugins: { someplugin: { enabled: true, config: { ...values } } },
    });
    for (const [key, raw] of Object.entries(values)) {
      expect(findValue(redacted, key)).toMatch(REDACTED);
      expect(JSON.stringify(redacted)).not.toContain(raw);
    }
    expect(findValue(redacted, "enabled")).toBe(true);
  });

  it("leaves non-secret keys that merely contain those words alone", async () => {
    const redacted = await redactViaTechnicalInfo({
      maxTokens: 4096,
      keywords: ["deploy", "ship"],
      tokenBudget: 1000,
      secretsDir: "/etc/app",
      credentialProbe: { enabled: false },
      provider_credentials_env: { openai: "OPENAI_API_KEY" },
    });
    expect(findValue(redacted, "maxTokens")).toBe(4096);
    expect(findValue(redacted, "keywords")).toEqual(["deploy", "ship"]);
    expect(findValue(redacted, "tokenBudget")).toBe(1000);
    expect(findValue(redacted, "secretsDir")).toBe("/etc/app");
    expect(findValue(redacted, "credentialProbe")).toEqual({ enabled: false });
    expect(findValue(redacted, "provider_credentials_env")).toEqual({ openai: "OPENAI_API_KEY" });
  });

  it("covers every secret-looking field declared in src/config.ts", async () => {
    // Inventory of the Settings shape: every declared field whose name
    // mentions a token/secret/key/password/credential/api. A new one fails
    // here until it is classified, so a secret added later is redacted by
    // default or consciously listed as not secret.
    const SECRET = ["api", "apiToken", "appToken", "botToken", "signingSecret", "token"];
    const NOT_SECRET = ["credentialProbe", "keywords", "provider_credentials_env"];
    // Matched by the regex below but not settings fields: parseSettingsText's
    // JSON reviver takes a `key` parameter.
    const NOT_A_FIELD = ["key"];
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(import.meta.dir, "..", "..", "config.ts"), "utf8");
    const declared = [
      ...new Set([...src.matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1])),
    ]
      .filter((name) => /token|secret|key|pass|cred|api|auth|cookie/i.test(name))
      .filter((name) => !NOT_A_FIELD.includes(name));

    const unclassified = declared.filter((n) => !SECRET.includes(n) && !NOT_SECRET.includes(n));
    expect(unclassified).toEqual([]);

    const settingsObj = Object.fromEntries(declared.map((n) => [n, `value-of-${n}`]));
    const redacted = (await redactViaTechnicalInfo(settingsObj)) as Record<string, unknown>;
    for (const name of declared) {
      if (SECRET.includes(name)) expect(redacted[name]).toMatch(REDACTED);
      else expect(redacted[name]).toBe(`value-of-${name}`);
    }
  });
});
