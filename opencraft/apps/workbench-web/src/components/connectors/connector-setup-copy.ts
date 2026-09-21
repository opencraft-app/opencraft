import type { ConnectorDefinition, ConnectorField, ConnectorInstance, ConnectorOAuthProgress } from "@opencraft/connector-core";

export const connectorCheckLabel = (definition: ConnectorDefinition) => definition.adapter === "api" ? "检查配置" : "测试连接";

export function connectorCredentialHelp(definition: ConnectorDefinition, field: ConnectorField,
  saved: ConnectorInstance | null, values: Readonly<Record<string, string>>): string | undefined {
  if (!field.secret || !saved?.configuredFields.includes(field.key)) return undefined;
  const changed = definition.fields.filter(item => !item.secret && values[item.key] !== saved.values[item.key]).map(item => item.label);
  if (changed.length) return `已修改“${changed.join("、")}”，请重新填写“${field.label}”。`;
  return "已保存，留空保留原值。";
}

export function connectorOAuthStatus(status: ConnectorOAuthProgress["status"]): string {
  switch (status) {
    case "pending": return "请在授权页面完成登录，并保持此窗口打开。";
    case "complete": return "授权已完成。测试连接后，可在聊天中选择使用。";
    case "cancelled": return "已停止等待授权结果。需要连接时，可重新登录授权。";
    case "expired": return "本次授权已超时，请重新登录授权。";
    case "failed": return "授权未完成，请重新登录授权。";
  }
}
