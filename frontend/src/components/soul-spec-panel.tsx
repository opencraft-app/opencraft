/**
 * SoulSpecPanel —— 渲染人设详情：解读散文 + 5 个维度（核心气质 / 外显风格 /
 * 语言系统 / 行动逻辑 / 隐藏特质），用于「人设解读」弹窗的内容区。
 *
 * 数据来自 `@/lib/soul-interpretations` 的 SOUL_SPECS。
 */
import { useT } from "@/i18n/t";
import type { SoulSpec } from "@/lib/soul-interpretations";

export function SoulSpecPanel({ spec }: { spec: SoulSpec }) {
  const t = useT();

  // 解读散文：末行加粗作为 CTA（对齐 SkillHub 渲染习惯）
  const lastNewline = spec.interpretation.lastIndexOf("\n");
  const interpretationBody =
    lastNewline === -1 ? "" : spec.interpretation.slice(0, lastNewline);
  const interpretationCta =
    lastNewline === -1
      ? spec.interpretation
      : spec.interpretation.slice(lastNewline + 1);

  return (
    <div className="flex flex-col gap-6">
      {/* 解读散文 */}
      <p
        className="whitespace-pre-wrap text-sm leading-[1.8em]"
        style={{ color: "rgba(0,0,0,0.70)" }}
      >
        {interpretationBody}
        {lastNewline !== -1 ? "\n" : ""}
        <span className="font-semibold">{interpretationCta}</span>
      </p>

      {/* 5 维度：核心气质 / 外显风格 / 语言系统 / 行动逻辑 / 隐藏特质 */}
      <div className="flex flex-col gap-4">
        <SpecSection title={t("核心气质")} content={spec.coreTemperament} />
        <SpecSection title={t("外显风格")} content={spec.outerStyle} />
        <SpecSection title={t("语言系统")} content={spec.languageSystem} />
        <SpecSection title={t("行动逻辑")} content={spec.actionLogic} />
        <SpecSection title={t("隐藏特质")} content={spec.hiddenTraits} />
      </div>
    </div>
  );
}

function SpecSection({ title, content }: { title: string; content: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4
        className="text-[13px] font-semibold"
        style={{ color: "rgba(0,0,0,0.85)", letterSpacing: "-0.1px" }}
      >
        {title}
      </h4>
      <p
        className="whitespace-pre-wrap text-[13px] leading-[1.7em]"
        style={{ color: "rgba(0,0,0,0.65)" }}
      >
        {content}
      </p>
    </div>
  );
}
