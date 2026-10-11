import type {Computer} from "@vela/client-core";

export const computerConnectionLabel: Record<
  Computer["connectionState"],
  string
> = {
  error: "连接失败",
  offline: "离线",
  online: "在线",
  unknown: "等待连接",
};

export function computerConnectionTone(
  state: Computer["connectionState"],
): "danger" | "neutral" | "positive" {
  if (state === "online") return "positive";
  if (state === "error") return "danger";
  return "neutral";
}

export interface ComputerListItemViewModel {
  accessibilityLabel: string;
  id: string;
  meta: string;
  selected: boolean;
  status: string;
  subtitle: string;
  title: string;
  tone: "danger" | "neutral" | "positive";
}

export function computerListItemViewModel(
  computer: Computer,
  selected: boolean,
): ComputerListItemViewModel {
  const status = computerConnectionLabel[computer.connectionState];
  return {
    accessibilityLabel: `打开 Computer ${computer.name}`,
    id: computer.id,
    meta: `${computer.osType} · ${status}`,
    selected,
    status,
    subtitle: computer.lifecycleState,
    title: computer.name,
    tone: computerConnectionTone(computer.connectionState),
  };
}
