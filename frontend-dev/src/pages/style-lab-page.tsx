import {
  ArrowRight,
  Bot,
  LayoutGrid,
  MessageSquareText,
  PanelsTopLeft,
  Sparkles,
  SwatchBook,
  Waypoints,
} from "lucide-react";
import { planCatalog } from "@/domain/plan-catalog";
import { ConfigSection } from "@/components/domain/config-section";
import { PlanCard } from "@/components/domain/plan-card";
import {
  GrammarCanvas,
  GrammarHero,
  GrammarMiniStat,
  GrammarPanel,
  GrammarSection,
} from "@/components/site/homepage-grammar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChatBubble } from "@/components/ui/chat-bubble";
import { ComposerPanel } from "@/components/ui/composer-panel";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/ui/stat-tile";

const principles = [
  "让 app 页面延续首页的暖色中性背景，而不是切回常规后台灰。",
  "让标题像编辑式分节，而不是控制台里的匿名卡片标题。",
  "让 app 模块看起来像是首页语言的延续，而不是另一套产品。",
];

const surfaceFamilies = [
  {
    title: "Editorial Shell",
    note: "用于章节、页头和强叙事区块。先给页面情绪，再给操作。",
  },
  {
    title: "Control Surface",
    note: "用于表单、统计、配置和列表。留白更克制，但边框和背景仍来自同一组语法。",
  },
  {
    title: "Embedded Workbench",
    note: "用于 workspace、聊天、计划选择等高密度区域。视觉上更紧，但不要丢掉温度。",
  },
];

export const StyleLabPage = () => (
  <GrammarCanvas>
    <GrammarHero
      eyebrow={<Badge variant="neutral">Internal Truth Source</Badge>}
      title="Homepage Grammar"
      description={
        <>
          <p className="text-lg font-semibold tracking-[-0.03em]" style={{ color: "var(--lw-fg)" }}>
            Marketing spirit, app discipline.
          </p>
          <p>
            这里不是控件墓地，而是把首页的叙事节奏、块面关系和表面语言翻译成 app 页面可复用的语法。
          </p>
        </>
      }
      actions={
        <>
          <button type="button" className="lw-btn-primary">
            Hero-led sections
            <ArrowRight className="h-4 w-4" />
          </button>
          <button type="button" className="lw-btn-secondary">
            App-ready surfaces
          </button>
        </>
      }
      aside={
        <GrammarPanel tone="muted" className="space-y-5">
          <div className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>
              Translation Rules
            </p>
            <div className="space-y-3">
              {principles.map((principle) => (
                <div key={principle} className="rounded-[1.1rem] border px-4 py-3 text-sm leading-7" style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.72)" }}>
                  {principle}
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
            <GrammarMiniStat label="Rhythm" value="5" note="从 hero、章节导语到 workbench，一页只保留五种明确节奏。" />
            <GrammarMiniStat label="Surface" value="3" note="所有页面都回收到三类表面，不再继续长出新卡片。" />
            <GrammarMiniStat label="Mood" value="1" note="首页和 app 共享一条叙事脉络，只是密度不同。" />
          </div>
        </GrammarPanel>
      }
    />

    <GrammarSection
      index="01"
      title="Foundations"
      description="先收的是页面底色、留白尺度和标题力度。统一风格不是换一组按钮，而是先让页面有同一种呼吸方式。"
    >
      <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <GrammarPanel className="space-y-5">
          <div className="flex items-center gap-3">
            <SwatchBook className="h-5 w-5" style={{ color: "var(--lw-accent)" }} />
            <h3 className="text-xl font-semibold tracking-[-0.04em]">Warm Neutral Base</h3>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["Canvas", "var(--lw-bg)"],
              ["Soft Section", "var(--lw-bg-secondary)"],
              ["Elevated Surface", "var(--lw-bg-elevated)"],
            ].map(([label, token]) => (
              <div key={label} className="space-y-3 rounded-[1.25rem] border p-4" style={{ borderColor: "var(--lw-border)" }}>
                <div className="h-20 rounded-[0.9rem] border" style={{ background: token, borderColor: "var(--lw-border)" }} />
                <div>
                  <p className="text-sm font-semibold">{label}</p>
                  <p className="text-xs tracking-[0.12em]" style={{ color: "var(--lw-fg-tertiary)" }}>
                    {token}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </GrammarPanel>

        <GrammarPanel tone="accent" className="space-y-4">
          <div className="flex items-center gap-3">
            <Waypoints className="h-5 w-5" style={{ color: "var(--lw-accent)" }} />
            <h3 className="text-xl font-semibold tracking-[-0.04em]">Spacing Cadence</h3>
          </div>
          <div className="space-y-3">
            {[
              ["Page hero", "48-72px of air before the first strong control"],
              ["Section intro", "narrative left rail + denser right-side work"],
              ["Work panel", "compact controls inside a generous parent shell"],
            ].map(([title, note]) => (
              <div key={title} className="rounded-[1.1rem] border px-4 py-3" style={{ borderColor: "rgba(232,229,224,0.9)", background: "rgba(255,255,255,0.72)" }}>
                <p className="text-sm font-semibold">{title}</p>
                <p className="mt-1 text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
                  {note}
                </p>
              </div>
            ))}
          </div>
        </GrammarPanel>
      </div>
    </GrammarSection>

    <GrammarSection
      index="02"
      title="Narrative Blocks"
      description="首页最大的价值不是橙色，而是章节像在讲同一个故事。app 页面也应该有导语、有重心、有从容的起手。"
    >
      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <GrammarPanel className="space-y-5">
          <div className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>
              Section Intro
            </p>
            <h3 className="max-w-2xl text-3xl font-semibold tracking-[-0.05em] sm:text-[2.4rem]">
              Every app page should start with a stance, not a widget.
            </h3>
            <p className="max-w-2xl text-base leading-8" style={{ color: "var(--lw-fg-secondary)" }}>
              先说明这一页负责什么、今天应该看什么，再把配置、表格和终端放进去。这样 dashboard 也会像首页一样有入口、有方向，而不是上来就是堆内容。
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-[1.1rem] border px-4 py-4" style={{ borderColor: "var(--lw-border)", background: "rgba(250,250,248,0.9)" }}>
              <p className="text-xs font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--lw-fg-tertiary)" }}>
                What shifts
              </p>
              <p className="mt-3 text-lg font-semibold tracking-[-0.04em]">从“页面说明”转成“章节导语”</p>
            </div>
            <div className="rounded-[1.1rem] border px-4 py-4" style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.72)" }}>
              <p className="text-xs font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--lw-fg-tertiary)" }}>
                What stays
              </p>
              <p className="mt-3 text-lg font-semibold tracking-[-0.04em]">功能密度仍然服务真实操作</p>
            </div>
          </div>
        </GrammarPanel>

        <GrammarPanel tone="muted" className="space-y-4">
          <div className="flex items-center gap-3">
            <PanelsTopLeft className="h-5 w-5" style={{ color: "var(--lw-accent)" }} />
            <h3 className="text-xl font-semibold tracking-[-0.04em]">Left Rail Discipline</h3>
          </div>
          <div className="space-y-3">
            {[
              "左侧写章节意图，不放大堆字段说明。",
              "右侧承接操作面、预览面和数据面。",
              "当内容变密时，先压缩内部控件，不先牺牲章节导语。",
            ].map((item) => (
              <div key={item} className="rounded-[1.1rem] border px-4 py-3 text-sm leading-7" style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.7)" }}>
                {item}
              </div>
            ))}
          </div>
        </GrammarPanel>
      </div>
    </GrammarSection>

    <GrammarSection
      index="03"
      title="Surface Families"
      description="全站页面最终只应该长出少量固定表面。这样登录、设置、工作台和计划页才能看起来是同一家产品，而不是四种模板。"
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {surfaceFamilies.map((family) => (
          <GrammarPanel key={family.title} className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>
              Surface Family
            </p>
            <h3 className="text-xl font-semibold tracking-[-0.04em]">{family.title}</h3>
            <p className="text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
              {family.note}
            </p>
            <div className="rounded-[1.2rem] border p-4" style={{ borderColor: "var(--lw-border)", background: family.title === "Embedded Workbench" ? "rgba(250,250,248,0.86)" : "rgba(255,255,255,0.78)" }}>
              <div className="space-y-2">
                <div className="h-3 w-20 rounded-full" style={{ background: "rgba(232,89,12,0.18)" }} />
                <div className="h-3 w-36 rounded-full" style={{ background: "rgba(26,26,26,0.12)" }} />
                <div className="h-20 rounded-[0.9rem] border" style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.82)" }} />
              </div>
            </div>
          </GrammarPanel>
        ))}
      </div>
    </GrammarSection>

    <GrammarSection
      index="04"
      title="Action Language"
      description="CTA 不是一套零散按钮，而是首页动作语气在 app 中的延续。主动作够清楚，次动作退后半步，文本链接保持轻。"
    >
      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <GrammarPanel className="space-y-4">
          <div className="flex items-center gap-3">
            <Sparkles className="h-5 w-5" style={{ color: "var(--lw-accent)" }} />
            <h3 className="text-xl font-semibold tracking-[-0.04em]">Homepage CTAs</h3>
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="lw-btn-primary">
              Start with intent
              <ArrowRight className="h-4 w-4" />
            </button>
            <button type="button" className="lw-btn-secondary">
              Secondary control
            </button>
            <button type="button" className="lw-link-underline text-sm font-semibold">
              Text-only follow-up
            </button>
          </div>
          <p className="text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
            app 页里的按钮不需要完全复制首页 CTA，但要继承这套关系：主按钮有明确推进感，次按钮像柔和的面板开关，文字动作始终轻。
          </p>
        </GrammarPanel>

        <GrammarPanel tone="muted" className="space-y-4">
          <div className="flex items-center gap-3">
            <LayoutGrid className="h-5 w-5" style={{ color: "var(--lw-accent)" }} />
            <h3 className="text-xl font-semibold tracking-[-0.04em]">App Controls</h3>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button>Save profile</Button>
            <Button variant="secondary">Preview changes</Button>
            <Button variant="outline">Open details</Button>
            <Button variant="ghost">Dismiss</Button>
          </div>
          <p className="text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
            这里的重点不是换掉所有控件，而是让 app 控件的节奏服从首页语气。按钮仍然服务操作，但不能把整个页面拉回到普通后台面板。
          </p>
        </GrammarPanel>
      </div>
    </GrammarSection>

    <GrammarSection
      index="05"
      title="App Mappings"
      description="真正重要的是把首页语法翻译成 dashboard、workspace、plan selection 和 settings 的可操作版本。下面这些 block 是后续全站统一时要直接复用的方向。"
    >
      <div className="space-y-4">
        <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
          <GrammarPanel className="space-y-5">
            <div className="space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--lw-fg-tertiary)" }}>
                Dashboard Hero
              </p>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <h3 className="text-3xl font-semibold tracking-[-0.05em]">总览页先讲态势，再落指标。</h3>
                  <p className="max-w-2xl text-sm leading-7" style={{ color: "var(--lw-fg-secondary)" }}>
                    不再是一排匿名统计卡，而是“今天这套系统正在怎样运转”的第一视图。
                  </p>
                </div>
                <Badge variant="success">Healthy rhythm</Badge>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile label="Running bots" value="12" />
              <StatTile label="Response median" value="428ms" />
              <StatTile label="Active operators" value="4" />
            </div>
          </GrammarPanel>

          <GrammarPanel tone="muted" className="space-y-4">
            <ConfigSection
              title="Settings translation"
              description="设置页不是白底表单墙，而是有章节感的配置区。"
              icon={<SwatchBook className="size-4" style={{ color: "var(--lw-accent)" }} />}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-sm font-medium">Agent mission</p>
                  <Input defaultValue="让新用户在第一次会话里理解 Lightclaw 的主价值。" />
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium">Operating mode</p>
                  <Input defaultValue="Guided, concise, high-trust" />
                </div>
              </div>
            </ConfigSection>
          </GrammarPanel>
        </div>

        <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
          <GrammarPanel className="space-y-4">
            <div className="flex items-center gap-3">
              <MessageSquareText className="h-5 w-5" style={{ color: "var(--lw-accent)" }} />
              <h3 className="text-xl font-semibold tracking-[-0.04em]">Workspace cadence</h3>
            </div>
            <div className="space-y-3 rounded-[1.35rem] border p-4" style={{ borderColor: "var(--lw-border)", background: "rgba(255,255,255,0.78)" }}>
              <ChatBubble tone="system">测试工作台已准备好，可直接发送提示词进行验证。</ChatBubble>
              <ChatBubble tone="assistant">你好，我是 Lightclaw Bot，先帮你梳理这次对话想达成什么结果。</ChatBubble>
              <ChatBubble tone="user">先给我一个面向新用户的欢迎 opening。</ChatBubble>
            </div>
            <ComposerPanel>
              <Input defaultValue="请输出第一轮欢迎语，并解释为什么这样开场。" />
              <Button className="sm:w-auto">
                <Bot className="size-4" />
                Send
              </Button>
            </ComposerPanel>
          </GrammarPanel>

          <div className="grid gap-4 lg:grid-cols-3">
            {planCatalog.map((plan) => (
              <PlanCard key={plan.tier} plan={plan} selected={plan.tier === "free"} />
            ))}
          </div>
        </div>
      </div>
    </GrammarSection>
  </GrammarCanvas>
);
