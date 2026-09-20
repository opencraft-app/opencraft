/**
 * 「正在创建」加载动效 —— Hermes 咖啡杯
 *
 * 原先内联在 agent-settings-page.tsx，因新手引导面板也要复用，
 * 抽到独立文件避免重复实现（引导面板若反向 import 页面会造成循环依赖）。
 *
 * 两种形态：
 *   - 不传 steps：原样式（咖啡杯 + 单行文案），供既有创建流程使用
 *   - 传 steps：咖啡杯下方追加步骤进度清单，供新手引导的长流程使用
 *     （一个模板最坏约 5 分钟，必须让用户看到在动什么）
 */

import { motion } from "framer-motion";
import { Check, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { useT } from "@/i18n/t";
import { assetUrl } from "@/lib/asset-url";
import { cn } from "@/lib/utils";
import type { SetupStepState } from "@/pages/marketing/agent-buddy-setup-runner";

/** 单行步骤：状态图标 + 文案 */
const StepRow = ({ state }: { state: SetupStepState }) => {
  const t = useT();
  const { status } = state;

  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {status === "done" ? (
          <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
        ) : status === "running" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-black/55" aria-hidden="true" />
        ) : status === "failed" ? (
          <X className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-black/15" />
        )}
      </span>
      <span className="min-w-0">
        <span
          className={cn(
            "block text-[13px] leading-5",
            status === "pending" && "text-black/30",
            status === "running" && "font-medium text-black/80",
            status === "done" && "text-black/50",
            status === "failed" && "text-black/70",
          )}
        >
          {/* 步骤文案是运行时拼装的（含技能名），无法被 i18n-extract 静态提取 */}
          {state.step.label}
        </span>
        {status === "failed" ? (
          <span className="mt-0.5 block text-[11px] leading-4 text-red-500">
            {/*
              有 error 就显示 error，不分 required 与否。
              原来非必需步骤统一显示「这一步没成功」，把真实原因吞掉了 ——
              技能安装失败时，用户和排障的人都只看到一句无信息量的提示，
              必须去诊断中心重跑命令才知道为什么。既然沙箱已经把 stderr
              带回来了，就直接给出来；没有 error 时才退回通用文案。
            */}
            {state.error || t("这一步没成功，稍后可在对应页面重试")}
          </span>
        ) : null}
      </span>
    </li>
  );
};

export const CreatingLoadingView = ({
  errorMessage,
  steps,
  partialFailureCount = 0,
  onContinue,
}: {
  errorMessage?: string | null;
  /** 传入则展示步骤进度清单 */
  steps?: SetupStepState[];
  /**
   * 非阻断步骤的失败数。
   *
   * 大于 0 时停在本页并给一个「完成」按钮 —— 让用户先看清哪几步红了。
   * 之前是设完提示就直接跳走，那行字随页面卸载一起消失，用户只看到
   * 「创建成功」，进去才发现技能没装、定时任务是空的。
   */
  partialFailureCount?: number;
  /** 「完成」回调，仅在 partialFailureCount > 0 时用到 */
  onContinue?: () => void;
}) => {
  const t = useT();
  /* 动态 "..." 计数：0 -> 1 -> 2 -> 3 -> 0 ... 每 450ms 切换 */
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    const interval = setInterval(() => {
      setDotCount((prev) => (prev % 3) + 1);
    }, 450);
    return () => clearInterval(interval);
  }, []);

  const dots = ".".repeat(dotCount);
  const hasSteps = Boolean(steps && steps.length > 0);
  const doneCount = steps?.filter((state) => state.status === "done").length ?? 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="flex flex-col items-center justify-center py-20"
    >
      {/* Hermes 咖啡杯 —— 对应 Figma 231:4742 中心图（从 2x2 sprite 中裁剪左上角） */}
      <motion.div
        animate={{ y: [0, -6, 0] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        className="mb-2"
      >
        <div
          className="h-[78px] w-[78px] overflow-hidden"
          style={{
            backgroundImage: `url(${assetUrl("/hermes-loading.png")})`,
            backgroundRepeat: "no-repeat",
            backgroundPosition: "0 0",
            backgroundSize: "156px 156px",
          }}
        />
      </motion.div>

      {/* 文案：单行 + 动态省略号 */}
      <p
        className="text-center"
        style={{
          fontFamily: "PingFang SC, -apple-system, BlinkMacSystemFont, sans-serif",
          fontWeight: 500,
          fontSize: 14,
          lineHeight: "2em",
          color: "rgba(0,0,0,0.9)",
        }}
      >
        {/* 有步骤失败时改写主文案 —— 顶着「正在喂咖啡」说失败会很割裂 */}
        {errorMessage ? (
          errorMessage
        ) : partialFailureCount > 0 ? (
          t("Bot 已创建，但有 {{count}} 项配置没成功", { count: partialFailureCount })
        ) : (
          <>
            {t("正在给 LightVela Bot 喂咖啡，唤醒大脑中")}
            <span className="inline-block" style={{ width: "1.5em", textAlign: "left" }}>
              {dots}
            </span>
          </>
        )}
      </p>

      {/* 步骤进度：仅长流程传入 steps 时渲染 */}
      {hasSteps ? (
        <div className="mt-6 w-full max-w-[420px]">
          <div className="mb-2 flex items-center justify-between text-[11px] font-medium text-black/40">
            <span>{t("配置进度")}</span>
            <span>
              {doneCount} / {steps!.length}
            </span>
          </div>
          {/* 进度条：用已完成步骤占比，避免"假进度" */}
          <div className="h-1 overflow-hidden rounded-full bg-black/[0.06]">
            <div
              className="h-full rounded-full bg-black/45 transition-all duration-500"
              style={{ width: `${Math.round((doneCount / steps!.length) * 100)}%` }}
            />
          </div>
          <ul className="mt-3">
            {steps!.map((state, index) => (
              <StepRow key={`${state.step.kind}-${index}`} state={state} />
            ))}
          </ul>

          {/*
            部分失败时的收尾：说清去哪补，再给一个明确的出口。
            没有这个按钮用户就卡在这页了（流程已经不会自己往下走）。
          */}
          {partialFailureCount > 0 && onContinue ? (
            <div className="mt-5 rounded-[6px] bg-black/[0.02] p-3.5">
              <p className="text-[12px] leading-[18px] text-black/55">
                {t("安装过程遇到了小阻碍，稍后可在「技能」和「定时任务」页面手动安装，Bot 本身已安装成功。")}
              </p>
              <button
                type="button"
                onClick={onContinue}
                className="mt-3 h-9 w-full rounded-full bg-black text-[13px] font-medium text-white transition hover:bg-black/85"
              >
                {t("进入 Bot")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </motion.div>
  );
};
