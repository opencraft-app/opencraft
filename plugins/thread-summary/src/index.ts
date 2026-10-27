import type { Context } from "@deepseek-ai/cordis";
import { lazy } from "react";

const Content = lazy(() => import("./content"));

/** The host supplies data and placement; unloading never ends conversation work. */
export const ThreadSummaryPlugin = Object.assign(function ThreadSummaryPlugin(ctx: Context) {
  ctx.effect(() => ctx.conversationSummary.register({
    id: "opencraft.thread-summary",
    title: { id: "threadSummary.title", defaultMessage: "Task info" },
    Component: Content,
  }));
}, { inject: ["conversationSummary"] });
