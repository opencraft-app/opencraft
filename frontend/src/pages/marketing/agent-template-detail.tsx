/**
 * 模板详情视图（静态 Demo，共享组件）
 * ──────────────────────────────────────────────────────────────
 * 两处复用：
 *   - 新手引导：点「模版推荐」卡片 → 弹窗直接显示详情
 *   - 总览页：「模板推荐」弹窗内 列表 → 点某项后切到详情（带返回）
 *
 * 左侧分类导航 + 右侧内容区；技能与定时任务渲染为双行条目。
 *
 * 命名说明：分类叫「用户画像」而不是「记忆」—— 模板里的 memories 实际写入
 * USER.md，MEMORY.md 是 Agent 自己在对话中维护的工作记忆，前端不碰。
 * 见 agent-buddy-setup.ts 的 buildUserProfileWriteCommand。
 */

import { ChevronLeft, Clock, Puzzle } from "lucide-react";
import { useMemo, useState } from "react";

import { useT } from "@/i18n/t";
import { cn } from "@/lib/utils";
import { GeometricAvatar } from "@/pages/marketing/agent-avatar-shapes";
import type { AgentTemplate } from "@/pages/marketing/agent-demo-templates";

type TemplateTabId = "instructions" | "profile" | "skills" | "routines";

/**
 * 人设正文渲染。
 *
 * instructions 用空行分段、`**…**` 做小标题。这里只做这两种最小语法，
 * 不引 markdown 依赖 —— 段落之间留白，避免长文糊成一片。
 */
const InstructionsText = ({ text }: { text: string }) => {
  const blocks = useMemo(
    () => text.split("\n\n").map((block) => block.split("\n").filter(Boolean)).filter((lines) => lines.length > 0),
    [text],
  );

  return (
    <div className="flex flex-col gap-3.5">
      {blocks.map((lines) => (
        <div key={lines.join("|")} className="flex flex-col gap-1">
          {lines.map((line) => {
            const heading = /^\*\*(.+?)\*\*(.*)$/.exec(line);
            if (heading) {
              return (
                <p key={line} className="text-[13px] leading-6 text-black/[0.88]">
                  <span className="font-semibold">{heading[1]}</span>
                  {heading[2]}
                </p>
              );
            }
            return (
              <p key={line} className="text-[13px] leading-6 text-black/60">
                {line}
              </p>
            );
          })}
        </div>
      ))}
    </div>
  );
};

export const TemplateDetailView = ({
  template,
  actionLabel,
  onAction,
  onBack,
}: {
  template: AgentTemplate;
  /** 主按钮文案，如「创建」/「切换」 */
  actionLabel: string;
  onAction: () => void;
  /** 传入则在左上角显示返回按钮（总览页的两步式流程） */
  onBack?: () => void;
}) => {
  const t = useT();
  const [tab, setTab] = useState<TemplateTabId>("instructions");

  // 没有技能的模板不展示「技能」分类，避免点进去看到空白
  const hasSkills = template.skills.length > 0;
  const tabs = useMemo(() => {
    const all: { id: TemplateTabId; label: string; hint: string }[] = [
      { id: "instructions", label: t("介绍"), hint: t("这个助手如何工作") },
      { id: "profile", label: t("用户画像"), hint: t("它已经知道的事") },
      { id: "skills", label: t("技能"), hint: t("可以运行的能力") },
      { id: "routines", label: t("定时任务"), hint: t("自动运行的任务") },
    ];
    return all.filter((item) => item.id !== "skills" || hasSkills);
  }, [hasSkills, t]);

  // 切模板时上一个模板可能停在已隐藏的分类上，兜底回到「介绍」
  const activeTab = tabs.some((item) => item.id === tab) ? tab : "instructions";

  /** 右侧内容区：介绍是分段文字，用户画像是列表，技能与定时任务是双行条目 */
  const renderPanel = () => {
    if (activeTab === "instructions") {
      return <InstructionsText text={template.instructions} />;
    }

    if (activeTab === "profile") {
      return (
        <ul className="flex flex-col gap-2.5">
          {template.memories.map((item) => (
            <li key={item} className="flex gap-2 text-[13px] leading-6 text-black/60">
              <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-black/25" />
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ul>
      );
    }

    if (activeTab === "skills") {
      return (
        <ul className="flex flex-col gap-2">
          {template.skills.map((skill) => (
            <li
              key={skill.slug}
              className="rounded-[4px] border border-black/[0.07] bg-white px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <Puzzle className="h-3.5 w-3.5 shrink-0 text-black/35" aria-hidden="true" />
                <span className="truncate text-[13px] font-medium text-black/[0.88]">{skill.name}</span>
                <code className="ml-auto shrink-0 rounded-full bg-black/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-black/40">
                  {skill.slug}
                </code>
              </div>
              <p className="mt-1 text-xs leading-5 text-black/45">{skill.desc}</p>
            </li>
          ))}
        </ul>
      );
    }

    return (
      <ul className="flex flex-col gap-2">
        {template.routines.map((routine) => (
          <li
            key={routine.label}
            className="rounded-[4px] border border-black/[0.07] bg-white px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 shrink-0 text-black/35" aria-hidden="true" />
              <span className="text-[13px] font-medium text-black/[0.88]">{routine.label}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-black/45">{routine.desc}</p>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 返回按钮：仅两步式流程传入 onBack 时显示 */}
      {onBack ? (
        <button
          type="button"
          aria-label={t("返回模板列表")}
          onClick={onBack}
          className="-ml-1 mb-2 inline-flex h-7 w-7 items-center justify-center rounded-[3px] text-black/45 transition hover:bg-black/[0.04] hover:text-black/75"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}

      {/* 头部：头像 + 名称 + 描述 + 主按钮 */}
      <div className="flex items-start justify-between gap-4 pr-6">
        <div className="flex min-w-0 items-start gap-3">
          {/* 弹窗主视觉，开启呼吸与眨眼 */}
          <GeometricAvatar shapeId={template.shapeId} color={template.color} size={56} alive />
          <div className="min-w-0">
            <h2 className="text-lg font-semibold leading-7 text-black/[0.92]">{template.name}</h2>
            <p className="mt-1 text-[13px] leading-5 text-black/50">{template.description}</p>
          </div>
        </div>
        {/* TODO(demo): 接真实创建 / 切换逻辑 */}
        <button
          type="button"
          onClick={onAction}
          className="shrink-0 rounded-full bg-black px-4 py-2 text-sm font-medium text-white transition hover:bg-black/85"
        >
          {actionLabel}
        </button>
      </div>

      <div className="mt-5 h-px bg-black/[0.07]" />

      {/* 主体：左侧分类 + 右侧内容。min-h-0 + flex-1 让内容区吃掉剩余高度，
          配合弹窗固定高度，切换分类时不产生跳动。 */}
      <div className="mt-5 grid min-h-0 flex-1 gap-4 sm:grid-cols-[minmax(0,176px)_minmax(0,1fr)]">
        <nav className="flex flex-col gap-1" aria-label={t("模板详情分类")}>
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={activeTab === item.id ? "true" : undefined}
              onClick={() => setTab(item.id)}
              className={cn(
                "rounded-[4px] px-3 py-2 text-left transition",
                activeTab === item.id ? "bg-black/[0.05]" : "hover:bg-black/[0.025]",
              )}
            >
              <span className="block text-[13px] font-medium text-black/[0.88]">{item.label}</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-black/40">{item.hint}</span>
            </button>
          ))}
        </nav>

        {/* 白色内容区：靠边框而不是灰底做分隔，整体更清爽 */}
        <div className="min-h-0 overflow-y-auto rounded-[4px] border border-black/[0.07] bg-white p-4">
          {renderPanel()}
        </div>
      </div>

      {/* 降低选择压力：让用户知道选模板不是一锤定音。
          shrink-0 防止被固定高度的弹窗压缩掉。 */}
      <p className="mt-3 shrink-0 text-center text-[11px] leading-5 text-black/35">
        {t("模板只是起点，人设、技能与定时任务在创建后都可以随时修改")}
      </p>
    </div>
  );
};
