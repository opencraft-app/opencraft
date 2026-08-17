import {
  OperationStatusList,
  isTerminalOperationState,
  operationKindLabel,
  operationStateLabel,
  type OperationPollingViewState,
  type OperationStatusItem,
} from "./operation-status-list";
import {
  SystemStatusIsland,
  type SystemStatusIslandTone,
} from "../primitives/system-status-island";

export type {
  OperationPollingViewState,
  OperationStatusItem,
} from "./operation-status-list";

export interface OperationStatusIslandProps {
  items: OperationStatusItem[];
  lifecycleHint?: string | null;
  onContinue(operationId: string): void | Promise<void>;
  testID?: string;
}

export interface OperationStatusIslandPresentation {
  busy: boolean;
  expandable: boolean;
  summary: string;
  tone: SystemStatusIslandTone;
}

const interruptedPollingStates = new Set<OperationPollingViewState>([
  "idle",
  "timed_out",
  "rate_limited",
  "query_error",
]);

const pollingStateLabel: Partial<Record<OperationPollingViewState, string>> = {
  idle: "等待手动查询",
  query_error: "查询失败",
  rate_limited: "等待限流恢复",
  timed_out: "等待继续查询",
};

export function deriveOperationStatusIsland(
  items: OperationStatusItem[],
  lifecycleHint: string | null | undefined,
): OperationStatusIslandPresentation | null {
  if (items.length === 0) {
    return lifecycleHint
      ? {
          busy: false,
          expandable: false,
          summary: lifecycleHint,
          tone: "warning",
        }
      : null;
  }
  const terminalCount = items.filter(item =>
    isTerminalOperationState(item.operation.state),
  ).length;
  const progress = `${terminalCount}/${items.length}`;
  const newest = (values: OperationStatusItem[]) => [...values].sort(
    (left, right) =>
      right.operation.createdAt.localeCompare(left.operation.createdAt) ||
      right.operation.id.localeCompare(left.operation.id),
  )[0]!;
  const failures = items.filter(item =>
    item.operation.state === "failed" || item.operation.state === "uncertain",
  );
  if (failures.length > 0) {
    const item = newest(failures);
    return presentationFor(item, operationStateLabel[item.operation.state], progress, "danger");
  }
  const interrupted = items.filter(item =>
    !isTerminalOperationState(item.operation.state) &&
    interruptedPollingStates.has(item.pollingState),
  );
  if (interrupted.length > 0) {
    const item = newest(interrupted);
    return presentationFor(
      item,
      pollingStateLabel[item.pollingState] ?? "等待继续查询",
      progress,
      "warning",
    );
  }
  const active = items.filter(item => !isTerminalOperationState(item.operation.state));
  if (active.length > 0) {
    const item = newest(active);
    return presentationFor(item, operationStateLabel[item.operation.state], progress, "info", true);
  }
  if (items.every(item => item.operation.state === "succeeded")) {
    return {
      busy: false,
      expandable: true,
      summary: `操作已完成 · ${progress}`,
      tone: "positive",
    };
  }
  return {
    busy: false,
    expandable: true,
    summary: `操作已更新 · ${progress}`,
    tone: "neutral",
  };
}

export function OperationStatusIsland({
  items,
  lifecycleHint,
  onContinue,
  testID = "operation-status-island",
}: OperationStatusIslandProps) {
  const presentation = deriveOperationStatusIsland(items, lifecycleHint);
  if (!presentation) return null;
  return (
    <SystemStatusIsland
      busy={presentation.busy}
      details={presentation.expandable ? (
        <OperationStatusList embedded items={items} onContinue={onContinue} />
      ) : undefined}
      summary={presentation.summary}
      testID={testID}
      tone={presentation.tone}
    />
  );
}

function presentationFor(
  item: OperationStatusItem,
  state: string,
  progress: string,
  tone: SystemStatusIslandTone,
  busy = false,
): OperationStatusIslandPresentation {
  return {
    busy,
    expandable: true,
    summary: `${operationKindLabel[item.operation.kind] ?? "后台操作"} · ${state} · ${progress}`,
    tone,
  };
}
