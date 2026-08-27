import { afterEach, describe, expect, it } from "vitest";

import i18n from "@/i18n";
import idID from "@/i18n/generated/id-ID.json";
import zhToKey from "@/i18n/generated/zh-to-key.json";
import { t } from "@/i18n/t";

const RENEWAL_COPY = [
  "临近到期",
  "即将到期",
  "剩余 {{days}} 天到期",
  "剩余 {{hours}} 小时到期",
  "剩余不足 1 小时到期",
  "套餐{{time}}，敬请期待",
  "续费功能敬请期待。",
  "续费功能敬请期待。套餐已过期，暂时无法发起续费。",
  "续费功能敬请期待。你仍可销毁当前套餐后重新购买。",
] as const;

const zhToKeyMap = zhToKey as Record<string, string>;
const idIDMap = idID as Record<string, string>;

const extractPlaceholders = (source: string): string[] => (
  Array.from(source.matchAll(/\{\{\s*([\w$]+)\s*\}\}/g), (match) => match[1]!)
);

afterEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("renewal Indonesian localization", () => {
  it.each(RENEWAL_COPY)("provides non-empty Indonesian copy for %s", (source) => {
    const key = zhToKeyMap[source];

    expect(key).toEqual(expect.stringMatching(/^k_/));
    expect(idIDMap[key!]).toMatch(/\S/);

    for (const placeholder of extractPlaceholders(source)) {
      expect(idIDMap[key!]).toMatch(new RegExp(`\\{\\{\\s*${placeholder}\\s*\\}\\}`));
    }
  });

  it("renders the global renewal reminder copy in Indonesian instead of an empty string", async () => {
    await i18n.changeLanguage("id-ID");

    expect(t("套餐{{time}}，敬请期待", {
      time: t("剩余 {{days}} 天到期", { days: 3 }),
    })).toBe("Paket berakhir dalam 3 hari lagi. Segera tersedia.");
    expect(t("续费功能敬请期待。套餐已过期，暂时无法发起续费。"))
      .toBe("Fitur perpanjangan segera tersedia. Paket ini sudah kedaluwarsa dan belum dapat diperpanjang.");
  });
});
