import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetChatUserIdsWarningsForTests,
  _setSettingsFileForTests,
  reloadSettings,
} from "../config";

/**
 * `slack.allowedUserIds` and `discord.allowedUserIds` through the REAL settings
 * loader (raw text included: Discord ids are also read from it, for precision).
 *
 * An empty list means "allow everyone" on every Slack and Discord runtime, so a
 * present value that is not a list (a single id written as a string or a
 * number) must not collapse to `[]`: it has to allow nobody, with a warning.
 */

// The allow checks of both runtimes: `src/commands/{slack,discord}.ts`
// (`length > 0 && !includes(id)` → reject) and `src/adapters/{slack,discord}/index.ts`
// (same rule on a Set built from the list). They must agree.
function allows(ids: string[], userId: string): boolean {
  const legacy = !(ids.length > 0 && !ids.includes(userId));
  const set = new Set(ids);
  const bus = !(set.size > 0 && !set.has(userId));
  expect(bus).toBe(legacy);
  return legacy;
}

type Platform = "slack" | "discord";

describe("settings loader — slack/discord allowedUserIds", () => {
  const dirs: string[] = [];

  beforeEach(() => _resetChatUserIdsWarningsForTests());

  afterEach(() => {
    _setSettingsFileForTests(undefined);
    _resetChatUserIdsWarningsForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function loadText(text: string) {
    const dir = mkdtempSync(join(tmpdir(), "ccplus-settings-chat-ids-"));
    dirs.push(dir);
    const file = join(dir, "settings.json");
    writeFileSync(file, text);
    _setSettingsFileForTests(file);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const settings = await reloadSettings();
      return { settings, warnings: warn.mock.calls.map(String) };
    } finally {
      warn.mockRestore();
    }
  }

  async function loadWith(platform: Platform, allowedUserIds: unknown) {
    const block: Record<string, unknown> = { token: "t" };
    if (allowedUserIds !== undefined) block.allowedUserIds = allowedUserIds;
    const { settings, warnings } = await loadText(JSON.stringify({ [platform]: block }));
    return { ids: settings[platform].allowedUserIds, warnings };
  }

  const cases: Array<[Platform, string]> = [
    ["slack", "U0123ABCD"],
    ["discord", "123456789012345678"],
  ];

  for (const [platform, id] of cases) {
    describe(platform, () => {
      it("a single id written as a string allows nobody, with a warning", async () => {
        const { ids, warnings } = await loadWith(platform, id);
        expect(ids.length).toBeGreaterThan(0);
        expect(allows(ids, id)).toBe(false);
        expect(allows(ids, "someone-else")).toBe(false);
        expect(warnings.some((w) => w.includes(`${platform}.allowedUserIds must be a list`))).toBe(
          true,
        );
      });

      it("a bare number, a boolean or an object allows nobody either", async () => {
        for (const value of [123456789, true, { id: id }]) {
          const { ids } = await loadWith(platform, value);
          expect(ids.length).toBeGreaterThan(0);
          expect(allows(ids, id)).toBe(false);
          expect(allows(ids, "123456789")).toBe(false);
        }
      });

      it("an empty string is still a present value: nobody is allowed", async () => {
        const { ids } = await loadWith(platform, "");
        expect(ids.length).toBeGreaterThan(0);
        expect(allows(ids, id)).toBe(false);
      });

      it("a valid list loads unchanged and silently", async () => {
        const { ids, warnings } = await loadWith(platform, [id, "987654321"]);
        expect(ids).toEqual([id, "987654321"]);
        expect(allows(ids, id)).toBe(true);
        expect(warnings.filter((w) => w.includes(`${platform}.allowedUserIds`))).toEqual([]);
      });

      it("absent, null or an explicit empty list → empty (allow-all, unchanged), no warning", async () => {
        for (const value of [undefined, null, []]) {
          const { ids, warnings } = await loadWith(platform, value);
          expect(ids).toEqual([]);
          expect(warnings.filter((w) => w.includes(`${platform}.allowedUserIds`))).toEqual([]);
        }
      });

      it("warns once per distinct problem, not on every 30 s hot-reload, and again after a fix", async () => {
        const first = await loadWith(platform, id);
        const second = await loadWith(platform, id);
        expect(first.warnings.filter((w) => w.includes(`${platform}.allowedUserIds`))).toHaveLength(
          1,
        );
        expect(second.warnings.filter((w) => w.includes(`${platform}.allowedUserIds`))).toEqual([]);
        expect(second.ids).toEqual(first.ids);
        expect((await loadWith(platform, [id])).warnings).toEqual([]);
        const again = await loadWith(platform, id);
        expect(
          again.warnings.some((w) => w.includes(`${platform}.allowedUserIds must be a list`)),
        ).toBe(true);
      });
    });
  }

  it("slack and discord warn independently", async () => {
    const { settings, warnings } = await loadText(
      JSON.stringify({ slack: { allowedUserIds: "U1" }, discord: { allowedUserIds: "42" } }),
    );
    expect(allows(settings.slack.allowedUserIds, "U1")).toBe(false);
    expect(allows(settings.discord.allowedUserIds, "42")).toBe(false);
    expect(warnings.some((w) => w.includes("slack.allowedUserIds must be a list"))).toBe(true);
    expect(warnings.some((w) => w.includes("discord.allowedUserIds must be a list"))).toBe(true);
  });

  it("discord: ids from a nested allowedUserIds never replace the real list", async () => {
    // The raw-text extractor stops at the first "}" of the discord block, so
    // a nested object holding its own allowedUserIds came first.
    const { settings } = await loadText(
      '{"discord":{"token":"t","busRouting":{"x":{"allowedUserIds":["999"]}},"allowedUserIds":["111"]}}',
    );
    expect(allows(settings.discord.allowedUserIds, "999")).toBe(false);
    expect(allows(settings.discord.allowedUserIds, "111")).toBe(true);
  });

  it("discord: a nested list never replaces a numeric list, nor truncates a longer one", async () => {
    const numeric = await loadText(
      '{"discord":{"busRouting":{"x":{"allowedUserIds":["999"]}},"allowedUserIds":[111]}}',
    );
    expect(numeric.settings.discord.allowedUserIds).toEqual(["111"]);
    const longer = await loadText(
      '{"discord":{"busRouting":{"x":{"allowedUserIds":["111"]}},"allowedUserIds":["111","222"]}}',
    );
    expect(longer.settings.discord.allowedUserIds).toEqual(["111", "222"]);
  });

  it("discord: a nested list does not turn an explicit [] or a string into someone else's list", async () => {
    const empty = await loadText(
      '{"discord":{"busRouting":{"x":{"allowedUserIds":["999"]}},"allowedUserIds":[]}}',
    );
    expect(empty.settings.discord.allowedUserIds).toEqual([]);
    const str = await loadText(
      '{"discord":{"busRouting":{"x":{"allowedUserIds":["999"]}},"allowedUserIds":"111"}}',
    );
    expect(allows(str.settings.discord.allowedUserIds, "999")).toBe(false);
    expect(allows(str.settings.discord.allowedUserIds, "111")).toBe(false);
  });

  it("discord: a foreign id that rounds to a real numeric id is never adopted", async () => {
    // 1234567890123456789 and ...790 are the same double.
    const layouts = [
      '{"discord":{"busRouting":{"x":{"allowedUserIds":["1234567890123456790"]}},"allowedUserIds":[1234567890123456789]}}',
      '{"agents":{"a":{"discord":{"allowedUserIds":["1234567890123456790"]}}},"discord":{"allowedUserIds":[1234567890123456789]}}',
      '{"discord":{"allowedUserIds":["1234567890123456790"]},"discord":{"allowedUserIds":[1234567890123456789]}}',
      '{"discord":{"allowedUserIds":["1234567890123456790"],"allowedUserIds":[1234567890123456789]}}',
      '{"discord":{"allowedUserIds":[1234567890123456790],"allowed\\u0055serIds":[1234567890123456789]}}',
      '{"disc\\u006frd":{"allowedUserIds":[1234567890123456789]},"agents":{"a":{"discord":{"allowedUserIds":[1234567890123456790]}}}}',
      '{"discord":{"token":"a{b","channelNames":{"1":"x"},"busRouting":{"x":{"allowedUserIds":["1234567890123456790"]}},"allowedUserIds":[1234567890123456789]}}',
    ];
    for (const text of layouts) {
      const { settings } = await loadText(text);
      expect(allows(settings.discord.allowedUserIds, "1234567890123456790")).toBe(false);
    }
  });

  it("discord: an id JSON could only read rounded is never allowed in its rounded form", async () => {
    // 1234567890123456789 reads back as 1234567890123456800. When the raw ids
    // are not usable (here a key written with a \u escape), the rounded id
    // must not become someone's access.
    const { settings, warnings } = await loadText(
      '{"note\\u0073":"x","discord":{"allowedUserIds":[1234567890123456789,"111"]}}',
    );
    expect(allows(settings.discord.allowedUserIds, "1234567890123456800")).toBe(false);
    expect(allows(settings.discord.allowedUserIds, "111")).toBe(true);
    expect(
      warnings.some((w) => w.includes("discord.allowedUserIds holds an entry that is not an id")),
    ).toBe(true);
    const only = await loadText(
      '{"note\\u0073" :"x","discord":{"allowedUserIds":[1234567890123456789]}}',
    );
    expect(only.settings.discord.allowedUserIds.length).toBeGreaterThan(0);
    expect(allows(only.settings.discord.allowedUserIds, "1234567890123456800")).toBe(false);
    expect(allows(only.settings.discord.allowedUserIds, "someone-else")).toBe(false);
  });

  it("discord: a \\u escape in a value does not cost the list its precision", async () => {
    const { settings, warnings } = await loadText(
      '{"x":"caf\\u00e9","discord":{"token":"\\u0074","allowedUserIds":[1234567890123456789]}}',
    );
    expect(settings.discord.allowedUserIds).toEqual(["1234567890123456789"]);
    expect(warnings.filter((w) => w.includes("discord.allowedUserIds"))).toEqual([]);
  });

  it("a nested list never yields a rounded id, on either platform", async () => {
    for (const platform of ["discord", "slack"] as const) {
      const { settings } = await loadText(
        `{"${platform}":{"allowedUserIds":[[1234567890123456789]]}}`,
      );
      const ids = settings[platform].allowedUserIds;
      expect(ids.length).toBeGreaterThan(0);
      expect(allows(ids, "1234567890123456800")).toBe(false);
      expect(allows(ids, "someone-else")).toBe(false);
    }
  });

  it("discord: a dead duplicate list that ends early never feeds the live one", async () => {
    // JSON.parse keeps the last list; a "]" inside the first must not let the
    // raw-text walk stop there and adopt it.
    for (const first of ["[[1234567890123456790]]", '[1234567890123456790,"]"]']) {
      const { settings } = await loadText(
        `{"discord":{"allowedUserIds":${first},"allowedUserIds":[1234567890123456789]}}`,
      );
      expect(allows(settings.discord.allowedUserIds, "1234567890123456790")).toBe(false);
    }
  });

  it("discord: a duplicated allowedUserIds key uses the list JSON keeps (the last one)", async () => {
    const { settings } = await loadText(
      '{"discord":{"allowedUserIds":["999"],"allowedUserIds":["111"]}}',
    );
    expect(settings.discord.allowedUserIds).toEqual(["111"]);
  });

  it("discord: a nested allowedUserIds does not cost the real list its precision", async () => {
    const { settings } = await loadText(
      '{"discord":{"busRouting":{"x":{"allowedUserIds":["5"]}},"allowedUserIds":[123456789012345678901]}}',
    );
    expect(settings.discord.allowedUserIds).toEqual(["123456789012345678901"]);
  });

  it("discord: a list is kept as written when the raw ids do not spell it", async () => {
    const { settings } = await loadText(
      '{"discord":{"allowedUserIds":["123456789012345678901","not-an-id"]}}',
    );
    expect(settings.discord.allowedUserIds).toEqual(["123456789012345678901", "not-an-id"]);
  });

  it("discord: precision is kept with nested objects and braces in strings before the list", async () => {
    const { settings } = await loadText(
      '{"discord":{"token":"a{b\\"c","channelNames":{"1":"x"},"allowedUserIds":[123456789012345678901]}}',
    );
    expect(settings.discord.allowedUserIds).toEqual(["123456789012345678901"]);
  });

  it("discord: precision is kept when a nested object comes after the list", async () => {
    const { settings } = await loadText(
      '{"discord":{"allowedUserIds":[123456789012345678901],"channelNames":{"1":"general"}}}',
    );
    expect(settings.discord.allowedUserIds).toEqual(["123456789012345678901"]);
  });

  it("discord: precision is kept for numeric and quoted snowflakes mixed in one list", async () => {
    const { settings } = await loadText(
      '{"discord":{"allowedUserIds":[123456789012345678901,"223456789012345678901"]}}',
    );
    expect(settings.discord.allowedUserIds).toEqual([
      "123456789012345678901",
      "223456789012345678901",
    ]);
  });

  it("discord: a large numeric snowflake in a list keeps its precision", async () => {
    const { settings, warnings } = await loadText(
      '{"discord":{"token":"t","allowedUserIds":[123456789012345678901]}}',
    );
    expect(settings.discord.allowedUserIds).toEqual(["123456789012345678901"]);
    expect(warnings.filter((w) => w.includes("discord.allowedUserIds"))).toEqual([]);
  });
});
