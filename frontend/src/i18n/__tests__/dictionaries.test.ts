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
const CJK_RE = /[\u4e00-\u9fff]/;
const PLACEHOLDER_RE = /\{\{\s*[\w.]+\s*\}\}/g;

function placeholdersOf(value: string): string[] {
  return (value.match(PLACEHOLDER_RE) ?? []).map((placeholder) => placeholder.replace(/\s/g, "")).sort();
}

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
   * id-ID 的 173 条缺口来自 master 上通道与模型配置相关功能
   * （钉钉 / 企业微信 / QQ / Kimi / 智谱等），应由对应需求负责人补齐。
   */
  const KNOWN_TRANSLATION_DEBT: Readonly<Record<string, number>> = {
    "id-ID": 173,
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

  it("新增语种字典已创建且 key 齐全", () => {
    /* es / ja-JP / ko-KR 已完成全量翻译并进入发布门禁。
       本用例锁定三份字典结构，各语种零空值由下方独立门禁负责。 */
    for (const dictKey of ["es", "ja-JP", "ko-KR"] as const) {
      const stat = progress.get(dictKey);
      expect(stat, `${dictKey} 字典未生成`).toBeDefined();
      expect(Object.keys(DICTS[dictKey]).length).toBe(BASE_KEYS.length);
    }
  });
});

describe("西语翻译完成门禁", () => {
  it("es 不含空译文", () => {
    const emptyKeys = Object.entries(es).flatMap(([key, value]) => (value === "" ? [key] : []));
    expect(emptyKeys, `es 仍有 ${emptyKeys.length} 条未翻译`).toEqual([]);
  });

  it("es 的每条非空译文保持占位符且不直接保留含汉字原文", () => {
    for (const [key, value] of Object.entries(es)) {
      if (!value) continue;

      const source = zhCN[key as keyof typeof zhCN];
      expect(placeholdersOf(value), `es ${key} 的占位符与中文原文不一致`).toEqual(placeholdersOf(source));
      expect(value === source && CJK_RE.test(source), `es ${key} 不得直接保留含汉字原文`).toBe(false);
    }
  });

  it("完整保留 Tencent Lighthouse 团队名", () => {
    const teamCopy = Object.entries(zhCN)
      .filter(([, source]) => source.includes("腾讯轻量云"))
      .map(([key]) => es[key as keyof typeof es]);

    expect(teamCopy).not.toContainEqual(expect.stringMatching(/Tencent Cloud Light/));
    expect(teamCopy.every((value) => value.includes("Tencent Lighthouse"))).toBe(true);
  });
});

describe("日语翻译完成门禁", () => {
  it("ja-JP 不含空译文", () => {
    const emptyKeys = Object.entries(jaJP).flatMap(([key, value]) => (value === "" ? [key] : []));
    expect(emptyKeys, `ja-JP 仍有 ${emptyKeys.length} 条未翻译`).toEqual([]);
  });

  it("ja-JP 保持占位符且不含机器翻译提示残留", () => {
    const promptLeakPattern = /ZXQ|LVNEWLINE|LV数字|英文参考|中文原文|保護マーク|保护标记/;

    for (const [key, value] of Object.entries(jaJP)) {
      const source = zhCN[key as keyof typeof zhCN];
      expect(placeholdersOf(value), `ja-JP ${key} 的占位符与中文原文不一致`).toEqual(
        placeholdersOf(source),
      );
      expect(value, `ja-JP ${key} 含机器翻译提示残留`).not.toMatch(promptLeakPattern);
    }
  });

  it("核心短文案使用日语 UI 表达并保持产品术语", () => {
    expect(jaJP.k_24575130).toBe("土曜日");
    expect(jaJP.k_744d02c0).toBe("承認をオフ");
    expect(jaJP.k_d61247ca).toBe("ソウル");
    expect(jaJP.k_0a666759).toBe("オフライン");
    expect(jaJP.k_9c418985).toBe("ゴールド");
    expect(jaJP.k_9905befc).toContain("Hermes Agent");
  });

  it("首页高可见文案使用自然日语并保持英文产品名", () => {
    expect(jaJP.k_6c779cec).toBe("やりたいことを伝えるだけ。あとはAIパートナーが対応します。");
    expect(jaJP.k_4f3b1439).toBe("レシピ");
    expect(jaJP.k_a1bd9760).toBe("スケジュールタスク");
    expect(jaJP.k_20f08c6e).toBe("ニュースダイジェスト");
    expect(jaJP.k_a512817f).toBe("水分補給リマインダー");
    expect(jaJP.k_60d063b6).toBe("ブログ");
    expect(jaJP.k_da90c775).toBe("Coding Planモデル");
    expect(jaJP.k_dceceeaf).toBe("セットアップ不要");
    expect(jaJP.k_6db1f265).toBe(
      "セルフホスティングも環境構築もAPIキー管理も不要です。クラウドでHermes Agentをすぐに利用できます。",
    );
    expect(jaJP.k_4e21f1d4).toBe("24時間365日稼働");
    expect(jaJP.k_fc61ee9e).toBe(
      "Hermes Agentは専用のクラウドインスタンスで動作するため、端末のバッテリーやメモリを消費しません。スマートフォンやパソコンからいつでも呼び出せ、すぐに応答します。",
    );
    expect(jaJP.k_8ed5493c).toBe("繰り返しの作業はHermesにお任せ");
    expect(jaJP.k_b6ff0105).toBe("関連製品");
    expect(jaJP.k_14833b0a).toBe(
      "© 2026 LightVela. All rights reserved. Tencent Lighthouse 提供。",
    );
  });
});

describe("韩语翻译完成门禁", () => {
  it("ko-KR 不含空译文", () => {
    const emptyKeys = Object.entries(koKR).flatMap(([key, value]) => (value === "" ? [key] : []));
    expect(emptyKeys, `ko-KR 仍有 ${emptyKeys.length} 条未翻译`).toEqual([]);
  });

  it("ko-KR 保持占位符且不含机器翻译提示残留", () => {
    const promptLeakPattern = /ZXQ|LVNEWLINE|英文参考|中文原文|번역 지침|보호 마커/;

    for (const [key, value] of Object.entries(koKR)) {
      const source = zhCN[key as keyof typeof zhCN];
      expect(placeholdersOf(value), `ko-KR ${key} 的占位符与中文原文不一致`).toEqual(
        placeholdersOf(source),
      );
      expect(value, `ko-KR ${key} 含机器翻译提示残留`).not.toMatch(promptLeakPattern);
    }
  });

  it("核心短文案使用韩语 UI 表达并保持固定术语", () => {
    expect(koKR.k_24575130).toBe("토요일");
    expect(koKR.k_744d02c0).toBe("승인 끄기");
    expect(koKR.k_44e4d7a3).toBe("메모리");
    expect(koKR.k_699143b1).toBe("스킬");
    expect(koKR.k_8000f187).toBe("모델");
    expect(koKR.k_a1bd9760).toBe("예약 작업");
    expect(koKR.k_d61247ca).toBe("페르소나");
    expect(koKR.k_e4f52ebc).toBe("채널");
  });

  it("首页高可见文案使用自然韩语并保持英文产品名", () => {
    expect(koKR.k_5d16b3fa).toBe("LightVela · 클라우드 기반 Hermes Agent");
    expect(koKR.k_78273f26).toBe("언제나 곁에서 함께 성장하는 AI 파트너");
    expect(koKR.k_6c779cec).toBe("원하는 일을 말해 주세요. 나머지는 AI 파트너가 처리합니다.");
    expect(koKR.k_4f3b1439).toBe("레시피");
    expect(koKR.k_a1bd9760).toBe("예약 작업");
    expect(koKR.k_20f08c6e).toBe("뉴스 요약");
    expect(koKR.k_a512817f).toBe("수분 섭취 알림");
    expect(koKR.k_46e38679).toBe("실행 중");
    expect(koKR.k_d679aea3).toBe("실행 중");
    expect(koKR.k_5a136705).toBe("홈으로 돌아가기");
    expect(koKR.k_86385379).toBe("개요");
    expect(koKR.k_23093bb2).toBe("업데이트 내역");
    expect(koKR.k_2e76d5c8).toBe("문서");
    expect(koKR.k_da90c775).toBe("Coding Plan 모델");
    expect(koKR.k_dceceeaf).toBe("설정 불필요");
    expect(koKR.k_6db1f265).toBe(
      "셀프 호스팅, 환경 구성, API 키 관리가 필요 없습니다. 클라우드에서 완전한 Hermes Agent를 바로 사용할 수 있습니다.",
    );
    expect(koKR.k_4e21f1d4).toBe("24시간 연중무휴");
    expect(koKR.k_8ed5493c).toBe("반복 작업은 Hermes에 맡기세요");
    expect(koKR.k_89a9e11e).toBe("LightVela 이용 방법");
    expect(koKR.k_01be26f3).toBe("물 한 잔 마시는 동안 클라우드의 Hermes Agent가 준비됩니다.");
    expect(koKR.k_26a64af5).toBe("물 한 잔 마시는 동안 클라우드의 Hermes Agent가 준비됩니다.");
    expect(koKR.k_ecb0cd78).toBe("시작하기");
    expect(koKR.k_da72cec6).toBe("바닥글 탐색");
    expect(koKR.k_e95597ee).toBe("셀프 호스팅과 비교");
    expect(koKR.k_a0e41ec0).toBe("Hostinger와 비교");
    expect(koKR.k_1d940924).toBe("Manus와 비교");
    expect(koKR.k_3b2e3653).toBe("회사 소개");
    expect(koKR.k_c1cfdfd3).toBe("서비스 이용약관");
    expect(koKR.k_e38f72fc).toBe("서비스 이용약관");
    expect(koKR.k_248f81e2).toBe("무료 체험");
    expect(koKR.k_d88baed5).toBe("무료 체험");
    expect(koKR.k_fc115671).toBe("무료 체험");
    expect(koKR.k_310eb572).toBe("7일 무료 체험");
    expect(koKR.k_5a84204f).toBe("무료 체험 선택");
    expect(koKR.k_e6dbe35f).toBe("14일 무료 체험");
    expect(koKR.k_14833b0a).toBe(
      "© 2026 LightVela. All rights reserved. Tencent Lighthouse 제공.",
    );
    expect(koKR.k_6de351e5).toBe("기기 자원을 소모하지 않고 언제든지 호출하세요");
    expect(koKR.k_50495c0d).toBe("정식 Hermes Agent, 클릭 한 번으로 바로 사용");
    expect(koKR.k_ff4289bd).toBe("정식 Hermes Agent,\n클릭 한 번으로 바로 사용");
    expect(koKR.k_45786e15).toBe("내 예약 작업 관리");
    expect(koKR.k_bdcffa6c).toBe("‘지금 만들기’를 클릭하세요");
    expect(koKR.k_7f472118).toBe("완전 자동 클라우드 프로비저닝");
    expect(koKR.k_c0f65be9).toBe("완전 자동 클라우드 프로비저닝");
    expect(koKR.k_7e359b79).toBe("새로운 여정—");
    expect(koKR.k_d7abd6c7).toBe("시작할 준비가 되셨나요");
    expect(koKR.k_7b6bd0b8).toBe("?");
    expect(koKR.k_5ea72ed7).toBe("AI가 클라우드에서 기다립니다. 어디서든 항상 함께합니다.");
    expect(koKR.k_8f0bbb96).toBe("AI가 클라우드에서 기다립니다. 어디서든 항상 함께합니다.");
    expect(koKR.k_888af1f2).toBe("커뮤니티");
    expect(koKR.k_c24697b5).toBe("Tencent CloudBase");
    expect(koKR.k_7ad1c108).toBe("언제나 온라인, 데이터는 온전히 내 것");
    expect(koKR.k_020a4682).toBe("대화 내용은\n나만의 공간에 저장");
    expect(koKR.k_cc96d3c2).toBe("대화 내용은 나만의 공간에만 저장");
    expect(koKR.k_aedf5b7e).toBe(
      "Hermes Agent와 나눈 모든 메시지는 전용 서버에 저장되며 제3자와 공유되지 않습니다. 언제든 직접 관리할 수 있습니다.",
    );
  });
});
