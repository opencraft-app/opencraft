/**
 * 新增语种字典装载测试
 * ──────────────────────────────────────────────────────────────
 * 验证注册表登记的每个语种都真实存在字典文件、条目齐全，
 * 并且翻译进度统计与注册表的 `translationRequired` 标记一致。
 *
 * 这类测试的价值在于：字典是 `pnpm i18n:extract` 生成的产物，
 * 若有人新增语种却忘记跑脚本，或手工删改字典文件，
 * 这里会立刻失败，而不是等到线上出现大面积文案回退。
 */

import { describe, expect, it } from "vitest";

import enUS from "../generated/en-US.json";
import es from "../generated/es.json";
import idID from "../generated/id-ID.json";
import jaJP from "../generated/ja-JP.json";
import koKR from "../generated/ko-KR.json";
import zhCN from "../generated/zh-CN.json";
import zhHant from "../generated/zh-Hant.json";
import zhToKey from "../generated/zh-to-key.json";
import { ALL_I18N_DICT_KEYS, LOCALE_DEFINITIONS, type I18nDictKey } from "../locales.config";

const DICTS: Record<I18nDictKey, Record<string, string>> = {
  "en-US": enUS,
  "zh-CN": zhCN,
  "zh-Hant": zhHant,
  "id-ID": idID,
  es,
  "ja-JP": jaJP,
  "ko-KR": koKR,
};

const BASE_KEYS = Object.keys(zhCN);

describe("字典文件完备性", () => {
  it("注册表登记的每个字典语种都有对应字典对象", () => {
    for (const dictKey of ALL_I18N_DICT_KEYS) {
      expect(DICTS[dictKey], `缺少字典: ${dictKey}`).toBeDefined();
    }
  });

  it("每个字典的 key 集合与中文基准字典完全一致", () => {
    /* key 缺失会导致该条文案静默回退中文；key 多余说明字典未随源码同步。 */
    for (const [dictKey, dict] of Object.entries(DICTS)) {
      if (dictKey === "zh-CN") continue;
      expect(Object.keys(dict).length, `${dictKey} 条目数与基准不一致`).toBe(BASE_KEYS.length);
      const missing = BASE_KEYS.filter((k) => !(k in dict));
      expect(missing, `${dictKey} 缺少 ${missing.length} 个 key`).toEqual([]);
    }
  });

  it("zh-to-key 反查表与基准字典双向一致", () => {
    const zhToKeyEntries = Object.entries(zhToKey as Record<string, string>);
    expect(zhToKeyEntries.length).toBe(BASE_KEYS.length);
    for (const [zh, key] of zhToKeyEntries) {
      expect((zhCN as Record<string, string>)[key], `hash ${key} 未出现在 zh-CN`).toBe(zh);
    }
  });

  it("基准字典与反查表不含空值", () => {
    for (const [key, value] of Object.entries(zhCN as Record<string, string>)) {
      expect(value, `zh-CN 的 ${key} 为空`).toBeTruthy();
    }
  });
});

describe("翻译进度与注册表标记一致", () => {
  /** 汇总每个字典的翻译完成情况。 */
  const progress = new Map<string, { translated: number; missing: number }>();
  for (const [dictKey, dict] of Object.entries(DICTS)) {
    const translated = Object.values(dict).filter((v) => v && v.length > 0).length;
    progress.set(dictKey, { translated, missing: BASE_KEYS.length - translated });
  }

  /**
   * 已知翻译债务基线。
   *
   * 这些缺口**不是**本次 locale 注册表重构引入的，而是此前存在、
   * 但被旧版 `i18n-extract.mjs` 掩盖的问题——旧脚本只校验 `en-US`
   * 一个语种，其余语种缺多少都不会让 CI 失败。
   *
   * 处理原则：
   *   - 不通过把 `translationRequired` 改成 false 来掩盖（那会让缺口
   *     彻底失去监控）；
   *   - 也不由本次重构越界代翻他人负责的业务文案；
   *   - 改为「棘轮式」基线：允许不超过既有缺口数，一旦有人新增未翻译
   *     文案导致缺口变大，测试立即失败。缺口补齐后应下调此基线。
   *
   * id-ID 的 178 条缺口来自 master 上通道与模型配置相关功能
   * （钉钉 / 企业微信 / QQ / Kimi / 智谱等），应由对应需求负责人补齐。
   */
  const KNOWN_TRANSLATION_DEBT: Readonly<Record<string, number>> = {
    "id-ID": 178,
  };

  it("标记为 translationRequired 的语种不得超出已知翻译债务基线", () => {
    for (const def of LOCALE_DEFINITIONS) {
      if (!def.translationRequired) continue;
      if (def.i18nKey === "zh-CN") continue;
      const stat = progress.get(def.i18nKey);
      expect(stat, `缺少 ${def.i18nKey} 的统计`).toBeDefined();

      const allowed = KNOWN_TRANSLATION_DEBT[def.i18nKey] ?? 0;
      expect(
        stat!.missing,
        `${def.i18nKey} 有 ${stat!.missing} 条未翻译，超出已知基线 ${allowed} 条。` +
          `请补齐新增文案的翻译；若确实需要放宽，请在 KNOWN_TRANSLATION_DEBT 中` +
          `更新基线并说明原因。`,
      ).toBeLessThanOrEqual(allowed);
    }
  });

  it("已知翻译债务基线不得虚高（缺口补齐后应及时下调）", () => {
    /* 防止基线长期挂着过大的数字失去约束力：
       实际缺口若已小于基线，说明有人补了翻译但忘记下调基线。 */
    for (const [dictKey, allowed] of Object.entries(KNOWN_TRANSLATION_DEBT)) {
      const stat = progress.get(dictKey);
      if (!stat) continue;
      expect(
        stat.missing,
        `${dictKey} 实际缺口 ${stat.missing} 已小于基线 ${allowed}，` +
          `请把 KNOWN_TRANSLATION_DEBT 中的基线下调为 ${stat.missing}。`,
      ).toBe(allowed);
    }
  });

  it("新增语种字典已创建，条目齐全（翻译可后续补齐）", () => {
    /* es / ja-JP / ko-KR 目前处于翻译进行中状态：
       字典文件必须已存在且 key 齐全，译文可以为空并回退中文。 */
    for (const dictKey of ["es", "ja-JP", "ko-KR"] as const) {
      const stat = progress.get(dictKey);
      expect(stat, `${dictKey} 字典未生成`).toBeDefined();
      expect(Object.keys(DICTS[dictKey]).length).toBe(BASE_KEYS.length);
    }
  });
});
