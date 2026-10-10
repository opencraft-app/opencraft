"use client";
import { lazy, Suspense } from "react";
import { AppLink } from "@/lib/app-navigation";
import { AGENTS_HOME_PATH } from "@/lib/agent-routes";
import { useCollaborationShown } from "@/lib/collaboration-visibility";
import { useT } from "@/i18n/t";

const Panel = lazy(() => import("./agent-collaboration-panel").then((module) => ({ default: module.AgentCollaborationPanel })));

/** The hidden route cannot load the SDK or create a session before explicit show(). */
export function AgentCollaborationLab() {
  const shown = useCollaborationShown();
  const t = useT();
  return (
    <section className="mx-auto w-full max-w-[1400px] p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold">{t("协作聊天")}</h1>
        <AppLink to={AGENTS_HOME_PATH} className="text-sm underline">{t("返回工作台")}</AppLink>
      </div>
      {shown ? <Suspense fallback={<p role="status">{t("正在加载…")}</p>}><Panel /></Suspense>
        : <p>{t("此实验室功能尚未开启。")}</p>}
    </section>
  );
}
