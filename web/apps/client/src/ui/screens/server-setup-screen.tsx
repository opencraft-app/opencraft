import type {
  AcceptedResource,
  Computer,
  CreateAgentInput,
  CreateComputerInput,
  RegistrationScript,
} from "@vela/client-core";
import {useEffect, useState} from "react";
import {ScrollView, Text, View} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import {CodeBlock} from "../components/management-workspace";
import {SystemButton} from "../primitives/system-button";
import {SystemField, SystemTextInput} from "../primitives/system-field";
import {SystemFeedback} from "../primitives/system-feedback";
import {SystemSegmentedControl} from "../primitives/system-segmented-control";

const agentHandlePattern = /^[a-z0-9][a-z0-9_-]{1,31}$/u;

export interface ServerSetupScreenProps {
  error: string | null;
  onContinue(): void;
  onCreateAgent(
    input: CreateAgentInput,
    options: {deployAndStart: boolean},
  ): AcceptedResource | null | Promise<AcceptedResource | null>;
  onCreateComputer(
    input: CreateComputerInput,
  ): Computer | null | Promise<Computer | null>;
  onOpenAgents(): void;
  onRefreshAgents(): void | Promise<void>;
  onRefreshComputers(): void | Promise<void>;
  onRequestRegistrationScript(
    computerId: string,
  ): RegistrationScript | null | Promise<RegistrationScript | null>;
  pendingAction: string | null;
  readiness: ServerSetupReadiness;
  serverName: string;
}

export type ServerSetupReadiness =
  | {agentId: string; stage: "ready"}
  | {stage: "connect_computer"}
  | {computerId: string; stage: "wait_computer_online"}
  | {computerId: string; stage: "create_agent"}
  | {agentId: string; stage: "start_agent"}
  | {stage: "ask_administrator"};

export function ServerSetupScreen({
  error,
  onContinue,
  onCreateAgent,
  onCreateComputer,
  onOpenAgents,
  onRefreshAgents,
  onRefreshComputers,
  onRequestRegistrationScript,
  pendingAction,
  readiness,
  serverName,
}: ServerSetupScreenProps) {
  const [computerName, setComputerName] = useState("");
  const [computerOSType, setComputerOSType] = useState<"macos" | "linux">("macos");
  const [agentName, setAgentName] = useState("");
  const [agentHandle, setAgentHandle] = useState("");
  const [registration, setRegistration] =
    useState<RegistrationScript | null>(null);
  const busy = pendingAction !== null;

  useEffect(() => {
    if (readiness.stage !== "wait_computer_online") return;
    const timer = setInterval(() => {
      void onRefreshComputers();
    }, 2_000);
    return () => clearInterval(timer);
  }, [onRefreshComputers, readiness.stage]);

  useEffect(() => {
    if (readiness.stage !== "start_agent") return;
    const timer = setInterval(() => {
      void onRefreshAgents();
    }, 2_000);
    return () => clearInterval(timer);
  }, [onRefreshAgents, readiness.stage]);

  const createComputerAndRegistration = async () => {
    const name = computerName.trim();
    if (!name) return;
    const computer = await onCreateComputer({name, osType: computerOSType});
    if (!computer) return;
    const value = await onRequestRegistrationScript(computer.id);
    if (value) setRegistration(value);
  };

  const requestRegistration = async (computerId: string) => {
    const value = await onRequestRegistrationScript(computerId);
    if (value) setRegistration(value);
  };

  const createAgent = async (computerId: string) => {
    if (!agentName.trim() || !agentHandlePattern.test(agentHandle.trim())) {
      return;
    }
    await onCreateAgent(
      {
        computerId,
        displayName: agentName.trim(),
        handle: agentHandle.trim(),
        replyPolicy: "mention_and_dm",
        runtime: {kind: "codex"},
      },
      {deployAndStart: true},
    );
  };

  return (
    <ScrollView contentContainerStyle={styles.root}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>SERVER SETUP</Text>
          <Text style={styles.title}>让 {serverName} 可以开始工作</Text>
          <Text style={styles.description}>
            连接一台 Computer，再创建第一个 Agent。完成后会直接进入对话。
          </Text>
        </View>

        <View style={styles.progress}>
          <ProgressItem
            active={readiness.stage === "connect_computer" || readiness.stage === "wait_computer_online"}
            complete={readiness.stage !== "connect_computer" && readiness.stage !== "wait_computer_online"}
            label="连接 Computer"
            number="1"
          />
          <ProgressItem
            active={readiness.stage === "create_agent" || readiness.stage === "start_agent"}
            complete={readiness.stage === "ready"}
            label="创建 Agent"
            number="2"
          />
          <ProgressItem
            active={readiness.stage === "ready"}
            complete={false}
            label="开始对话"
            number="3"
          />
        </View>

        {error ? (
          <SystemFeedback kind="inline" message={error} tone="danger" />
        ) : null}

        <View style={styles.card}>
          {readiness.stage === "connect_computer" ? (
            <>
              <StepCopy
                description="创建 Computer 后会生成一次性安装命令。在要运行 Codex Runtime 的机器上执行它。"
                title="连接第一台 Computer"
              />
              <SystemField label="Computer 名称" labelTone="primary">
                <SystemTextInput
                  accessibilityLabel="Computer 名称"
                  editable={!busy}
                  onChangeText={setComputerName}
                  placeholder="例如：本地开发机"
                  value={computerName}
                />
              </SystemField>
              <SystemField label="预期平台" labelTone="primary">
                <SystemSegmentedControl<"macos" | "linux">
                  accessibilityLabel="选择预期 Computer 平台"
                  disabled={busy}
                  onChange={setComputerOSType}
                  options={[
                    {label: "macOS", value: "macos"},
                    {label: "Linux", value: "linux"},
                  ]}
                  value={computerOSType}
                />
                <Text style={styles.hint}>
                  安装命令会自动检测实际机器，选择不一致也不会阻断。
                </Text>
              </SystemField>
              <SystemButton
                busy={busy}
                disabled={!computerName.trim()}
                label="生成连接命令"
                onPress={() => void createComputerAndRegistration()}
                variant="standard"
              />
            </>
          ) : null}

          {readiness.stage === "wait_computer_online" ? (
            <>
              <StepCopy
                description="在目标机器执行安装命令。页面会自动检测连接状态。"
                title="等待 Computer 上线"
              />
              {!registration ? (
                <SystemButton
                  busy={busy}
                  label="生成安装命令"
                  onPress={() => void requestRegistration(readiness.computerId)}
                  variant="standard"
                />
              ) : null}
              <SystemFeedback
                kind="inline"
                message="正在等待 Computer 建立连接…"
              />
            </>
          ) : null}

          {registration ? (
            <View style={styles.command}>
              <Text style={styles.commandLabel}>一次性安装命令</Text>
              <CodeBlock value={registration.script} />
              <Text style={styles.hint}>命令包含一次性凭据，请勿转发。</Text>
            </View>
          ) : null}

          {readiness.stage === "create_agent" ? (
            <>
              <StepCopy
                description="Agent 会部署到刚连接的 Computer，并在创建后自动启动。"
                title="创建第一个 Agent"
              />
              <SystemField label="Agent 名称" labelTone="primary">
                <SystemTextInput
                  accessibilityLabel="Agent 名称"
                  editable={!busy}
                  onChangeText={setAgentName}
                  placeholder="例如：研究助手"
                  value={agentName}
                />
              </SystemField>
              <SystemField label="Agent Handle" labelTone="primary">
                <SystemTextInput
                  accessibilityLabel="Agent Handle"
                  autoCapitalize="none"
                  editable={!busy}
                  invalid={Boolean(agentHandle) && !agentHandlePattern.test(agentHandle.trim())}
                  onChangeText={setAgentHandle}
                  placeholder="research"
                  value={agentHandle}
                />
              </SystemField>
              <SystemButton
                busy={busy}
                disabled={!agentName.trim() || !agentHandlePattern.test(agentHandle.trim())}
                label="创建并启动 Agent"
                onPress={() => void createAgent(readiness.computerId)}
                variant="standard"
              />
            </>
          ) : null}

          {readiness.stage === "start_agent" ? (
            <>
              <StepCopy
                description="正在检测 Agent 运行状态。也可以打开 Agent 页面完成部署、启动或查看错误。"
                title="等待 Agent 启动"
              />
              <SystemButton
                label="打开 Agent"
                onPress={onOpenAgents}
                variant="standard"
              />
            </>
          ) : null}

          {readiness.stage === "ask_administrator" ? (
            <>
              <StepCopy
                description="只有 Server Owner 或 Admin 可以创建 Agent。你仍然可以先进入 Server。"
                title="请管理员创建 Agent"
              />
              <SystemButton
                label="进入 Server"
                onPress={onContinue}
                variant="standard"
              />
            </>
          ) : null}

          {readiness.stage === "ready" ? (
            <>
              <StepCopy
                description="Computer 已连接，Agent 正在运行。现在可以发出第一条任务了。"
                title="一切就绪"
              />
              <SystemButton
                label="开始对话"
                onPress={onContinue}
                variant="standard"
              />
            </>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}

function ProgressItem({
  active,
  complete,
  label,
  number,
}: {
  active: boolean;
  complete: boolean;
  label: string;
  number: string;
}) {
  return (
    <View style={styles.progressItem}>
      <View style={[styles.progressDot, (active || complete) && styles.progressDotActive]}>
        <Text style={[styles.progressNumber, (active || complete) && styles.progressNumberActive]}>
          {complete ? "✓" : number}
        </Text>
      </View>
      <Text style={[styles.progressLabel, active && styles.progressLabelActive]}>{label}</Text>
    </View>
  );
}

function StepCopy({description, title}: {description: string; title: string}) {
  return (
    <View style={styles.stepCopy}>
      <Text style={styles.stepTitle}>{title}</Text>
      <Text style={styles.stepDescription}>{description}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.semantic.color.sectionSurface,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.section,
    borderWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.md,
    padding: theme.spacing.xl,
  },
  command: {gap: theme.spacing.xs},
  commandLabel: {color: theme.semantic.color.textPrimary, ...theme.semantic.typography.bodySmallEmphasis},
  content: {gap: theme.spacing.xl, maxWidth: 720, width: "100%"},
  description: {color: theme.semantic.color.textMuted, ...theme.semantic.typography.body},
  eyebrow: {color: theme.semantic.color.textLink, ...theme.semantic.typography.eyebrow},
  header: {gap: theme.spacing.sm},
  hint: {color: theme.semantic.color.textMuted, ...theme.semantic.typography.meta},
  progress: {flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.lg},
  progressDot: {
    alignItems: "center",
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.circle,
    borderWidth: theme.semantic.stroke.hairline,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  progressDotActive: {backgroundColor: theme.semantic.color.actionPrimarySurface, borderColor: theme.semantic.color.actionPrimarySurface},
  progressItem: {alignItems: "center", flexDirection: "row", gap: theme.spacing.xs},
  progressLabel: {color: theme.semantic.color.textMuted, ...theme.semantic.typography.bodySmall},
  progressLabelActive: {color: theme.semantic.color.textPrimary, ...theme.semantic.typography.bodySmallEmphasis},
  progressNumber: {color: theme.semantic.color.textMuted, ...theme.semantic.typography.overline},
  progressNumberActive: {color: theme.semantic.color.actionPrimaryText},
  root: {alignItems: "center", flexGrow: 1, padding: theme.spacing.xl},
  stepCopy: {gap: theme.spacing.xs},
  stepDescription: {color: theme.semantic.color.textMuted, ...theme.semantic.typography.body},
  stepTitle: {color: theme.semantic.color.textPrimary, ...theme.semantic.typography.detailTitle},
  title: {color: theme.semantic.color.textPrimary, ...theme.semantic.typography.pageTitle},
}));
