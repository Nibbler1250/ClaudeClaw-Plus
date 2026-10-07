/**
 * The web UI save handlers rewrite the whole settings.json. A Discord id
 * written as a bare number past 2^53 must come back to disk exactly as it was
 * written, or the loader reads the rounded text as an exact id: the owner is
 * refused and whoever holds the rounded id is allowed (#496).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, copyFile, unlink, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { updateHeartbeatSettings } from "../services/settings";
import { updateLlmRouterSettings } from "../services/llm-router-settings";
import { _setSettingsFileForTests, reloadSettings } from "../../config";

const SETTINGS_DIR = join(process.cwd(), ".claude", "claudeclaw");
const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
const BACKUP_FILE = join(SETTINGS_DIR, "settings.json.save-precision-test-backup");

const OWNER = "123456789012345678901";
const ROUNDED = String(Number(OWNER)); // "123456789012345680000"

const SEED = `{
  "heartbeat": { "enabled": false, "interval": 15, "prompt": "" },
  "discord": {
    "token": "",
    "allowedUserIds": [${OWNER}],
    "listenChannels": [987654321098765432109]
  },
  "nested": { "big": 900719925474099312345, "negative": -${OWNER}, "small": 42, "float": 1.5, "safe": 9007199254740991 }
}
`;

beforeAll(async () => {
  await mkdir(SETTINGS_DIR, { recursive: true });
  if (existsSync(SETTINGS_FILE)) await copyFile(SETTINGS_FILE, BACKUP_FILE);
});

afterAll(async () => {
  if (existsSync(BACKUP_FILE)) {
    await copyFile(BACKUP_FILE, SETTINGS_FILE);
    await unlink(BACKUP_FILE);
  } else if (existsSync(SETTINGS_FILE)) {
    await unlink(SETTINGS_FILE);
  }
});

afterEach(() => {
  _setSettingsFileForTests();
});

async function expectIdsKept(): Promise<void> {
  const text = await readFile(SETTINGS_FILE, "utf-8");
  expect(text).toMatch(new RegExp(`\\[\\s*${OWNER}\\s*\\]`));
  expect(text).toContain(`-${OWNER}`);
  expect(text).toContain("987654321098765432109");
  expect(text).toContain("900719925474099312345");
  expect(text).not.toContain(ROUNDED);

  _setSettingsFileForTests(SETTINGS_FILE);
  const settings = await reloadSettings();
  expect(settings.discord.allowedUserIds).toContain(OWNER);
  expect(settings.discord.allowedUserIds).not.toContain(ROUNDED);
}

describe("web UI settings save keeps large integers as written (#496)", () => {
  it("updateHeartbeatSettings applies the patch and keeps the Discord ids", async () => {
    await writeFile(SETTINGS_FILE, SEED);
    const r = await updateHeartbeatSettings({ interval: 30, enabled: true });
    expect(r.interval).toBe(30);
    expect(r.enabled).toBe(true);
    await expectIdsKept();
    const data = JSON.parse(await readFile(SETTINGS_FILE, "utf-8"));
    expect(data.heartbeat.interval).toBe(30);
    expect(data.nested).toEqual({
      big: Number("900719925474099312345"),
      negative: -Number(OWNER),
      small: 42,
      float: 1.5,
      safe: 9007199254740991,
    });
  });

  it("updateLlmRouterSettings applies the patch and keeps the Discord ids", async () => {
    await writeFile(SETTINGS_FILE, SEED);
    const r = await updateLlmRouterSettings({ tiers: { fast: ["a/b"] } });
    expect(r.tiers.fast).toEqual(["a/b"]);
    await expectIdsKept();
  });

  it("a second save keeps the ids too", async () => {
    await writeFile(SETTINGS_FILE, SEED);
    await updateHeartbeatSettings({ interval: 20 });
    await updateLlmRouterSettings({ tiers: { balanced: ["c/d"] } });
    await updateHeartbeatSettings({ prompt: "x" });
    await expectIdsKept();
  });

  it("refuses to save, and leaves the file as it was, when the runtime cannot write the integer back", async () => {
    await writeFile(SETTINGS_FILE, SEED);
    const json = JSON as unknown as { rawJSON?: unknown };
    const saved = json.rawJSON;
    delete json.rawJSON;
    try {
      await expect(updateHeartbeatSettings({ interval: 30 })).rejects.toThrow("2^53");
    } finally {
      json.rawJSON = saved;
    }
    expect(await readFile(SETTINGS_FILE, "utf-8")).toBe(SEED);
  });

  it("a file without large integers saves as before", async () => {
    await writeFile(
      SETTINGS_FILE,
      '{"discord":{"allowedUserIds":["123456789012345678901"]},"n":1e3}\n',
    );
    await updateHeartbeatSettings({ interval: 5 });
    expect(JSON.parse(await readFile(SETTINGS_FILE, "utf-8"))).toEqual({
      discord: { allowedUserIds: ["123456789012345678901"] },
      n: 1000,
      heartbeat: { interval: 5 },
    });
  });

  it("answers the save even when a heartbeat field itself holds a large integer", async () => {
    await writeFile(
      SETTINGS_FILE,
      '{"heartbeat":{"interval":100000000000000000000,"excludeWindows":[{"start":"01:00","end":"02:00","days":[123456789012345678901]}]}}\n',
    );
    const r = await updateHeartbeatSettings({ enabled: true });
    expect(r.enabled).toBe(true);
    expect(r.interval).toBe(1e20);
    expect(r.excludeWindows[0]?.days).toEqual([Number("123456789012345678901")]);
    const text = await readFile(SETTINGS_FILE, "utf-8");
    expect(text).toContain("100000000000000000000");
    expect(text).toContain("123456789012345678901");
  });
});
