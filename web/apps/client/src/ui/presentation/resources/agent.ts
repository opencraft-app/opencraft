import type {Agent} from "@vela/client-core";

export type ResourceStatusTone =
  | "danger"
  | "info"
  | "neutral"
  | "positive"
  | "warning";

export const agentActionLabel = {
  deploy: "部署",
  restart: "重启",
  start: "启动",
  stop: "停止",
} as const;

export const agentReplyPolicyLabel: Record<Agent["replyPolicy"], string> = {
  all_channel_messages: "全部频道消息",
  dm_only: "仅私信",
  mention_and_dm: "提及与私信",
};

const agentObservedStateLabel: Record<Agent["observedState"], string> = {
  deploying: "部署中",
  error: "异常",
  running: "运行中",
  starting: "启动中",
  stopped: "已停止",
  stopping: "停止中",
  unknown: "状态未知",
};

export function agentRuntimeStateLabel(agent: Agent): string {
  return agent.observedState === "unknown"
    ? "待部署"
    : agentObservedStateLabel[agent.observedState];
}

export function agentRuntimeStateTone(agent: Agent): ResourceStatusTone {
  switch (agent.observedState) {
    case "running":
      return "positive";
    case "error":
      return "danger";
    case "deploying":
    case "starting":
      return "info";
    case "stopping":
      return "warning";
    case "stopped":
    case "unknown":
      return "neutral";
  }
}

export interface AgentListItemViewModel {
  accessibilityLabel: string;
  id: string;
  meta: string;
  monogram: string;
  selected: boolean;
  status: string;
  subtitle: string;
  title: string;
  tone: ResourceStatusTone;
}

export function agentListItemViewModel(
  agent: Agent,
  selected: boolean,
): AgentListItemViewModel {
  const status = agentRuntimeStateLabel(agent);
  return {
    accessibilityLabel: `打开 Agent ${agent.handle}`,
    id: agent.id,
    meta: `@${agent.handle} · ${status}`,
    monogram: agent.displayName.slice(0, 1),
    selected,
    status,
    subtitle: agent.runtime.kind,
    title: agent.displayName,
    tone: agentRuntimeStateTone(agent),
  };
}
