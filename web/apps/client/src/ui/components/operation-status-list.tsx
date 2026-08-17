import type { Operation } from "@vela/client-core";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { productErrorMessage } from "../../application/product-language";
import {SystemButton} from "../primitives/system-button";

export type OperationPollingViewState =
  | "idle"
  | "polling"
  | "terminal"
  | "timed_out"
  | "rate_limited"
  | "query_error";

export interface OperationStatusItem {
  message?: string;
  operation: Operation;
  pollingState: OperationPollingViewState;
  resourceId?: string;
  retryAfterSeconds?: number;
}

export interface OperationStatusListProps {
  embedded?: boolean;
  items: OperationStatusItem[];
  onContinue(operationId: string): void | Promise<void>;
}

export function OperationStatusList({
  embedded = false,
  items,
  onContinue,
}: OperationStatusListProps) {
  if (items.length === 0) return null;
  return (
    <View style={[styles.list, embedded && styles.listEmbedded]}>
      {!embedded ? <Text style={styles.title}>后台执行状态</Text> : null}
      {items.map((item) => {
        const { operation } = item;
        const terminal = isTerminalOperationState(operation.state);
        const detail = productOperationMessage(
          operation.error?.message ??
            item.message ??
            (operation.state === "failed" || operation.state === "uncertain"
              ? "后台未提供失败详情"
              : null),
        );
        return (
          <View key={operation.id} style={styles.item}>
            <View style={styles.copy}>
              <Text style={styles.kind}>
                {operationKindLabel[operation.kind] ?? "后台操作"}
              </Text>
              <Text style={styles.status}>
                {operationStateLabel[operation.state]}
              </Text>
              {detail ? <Text style={styles.message}>{detail}</Text> : null}
              {terminal ? (
                <Text style={styles.time}>
                  {operation.completedAt ?? "完成时间未知"}
                </Text>
              ) : null}
            </View>
            {!terminal && item.pollingState !== "polling" ? (
              <SystemButton
                accessibilityLabel={`继续查询操作 ${operation.id}`}
                label={item.pollingState === "idle" ? "查询状态" : "继续查询"}
                onPress={() => onContinue(operation.id)}
                variant="standard"
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const terminalStates = new Set<Operation["state"]>([
  "succeeded",
  "failed",
  "uncertain",
  "superseded",
]);

export function isTerminalOperationState(state: Operation["state"]): boolean {
  return terminalStates.has(state);
}

export const operationStateLabel: Record<Operation["state"], string> = {
  failed: "失败",
  pending: "等待执行",
  retry_wait: "等待重试",
  running: "执行中",
  succeeded: "成功",
  superseded: "已被新操作替代",
  uncertain: "结果不确定",
};

export const operationKindLabel: Record<string, string> = {
  "agent.deploy": "部署 Agent",
  "agent.credential.rotate": "轮换运行凭证",
  "agent.restart": "重启 Agent",
  "agent.start": "启动 Agent",
  "agent.stop": "停止 Agent",
  "channel.create": "创建 Channel",
  "im.identity.ensure": "准备消息身份",
};

function productOperationMessage(message: string | null): string | null {
  if (!message) return null;
  return productErrorMessage(message);
}

const styles = StyleSheet.create((theme) => ({
  copy: {
    flex: 1,
    gap: theme.spacing.xs,
  },
  item: {
    alignItems: "center",
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    flexDirection: "row",
    gap: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  kind: {
    ...theme.semantic.typography.navigationLabel,
  },
  list: {
    backgroundColor: theme.semantic.color.surfaceMuted,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.xs,
    maxWidth: theme.recipes.contentMeasure.messageMaxWidth,
    padding: theme.spacing.md,
  },
  listEmbedded: {
    backgroundColor: theme.semantic.color.surfaceTransparent,
    borderWidth: 0,
    maxWidth: "100%",
    padding: 0,
  },
  message: {
    color: theme.semantic.color.statusDangerText,
    ...theme.semantic.typography.bodySmall,
  },
  status: {
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  time: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.micro,
  },
  title: {
    ...theme.semantic.typography.navigationGlyph,
  },
}));
