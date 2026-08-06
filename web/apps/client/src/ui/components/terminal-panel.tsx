import type {
  TerminalControllerState,
  TerminalControlKey,
} from "@vela/client-core";
import { useEffect, useRef, useState } from "react";
import {
  AppState,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface TerminalSurfaceController {
  close(): void;
  open(): Promise<void>;
  resize(cols: number, rows: number): void;
  sendControl(key: TerminalControlKey): void;
  snapshot(): TerminalControllerState;
  submitLine(value: string): void;
  subscribe(listener: (state: TerminalControllerState) => void): () => void;
  writeText(value: string): void;
}

export interface TerminalPanelProps {
  controller: TerminalSurfaceController;
  name: string;
  onClose(): void;
}

export function TerminalPanel({
  controller,
  name,
  onClose,
}: TerminalPanelProps) {
  const [command, setCommand] = useState("");
  const [state, setState] = useState(controller.snapshot());
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    const appStateSubscription = AppState.addEventListener(
      "change",
      (nextState) => {
        if (nextState === "active") return;
        controller.close();
        onCloseRef.current();
      },
    );
    void controller.open();
    return () => {
      appStateSubscription.remove();
      unsubscribe();
      controller.close();
    };
  }, [controller]);

  const ready = state.status === "ready";
  return (
    <View style={styles.panel} testID="computer-terminal-panel">
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>{name} / 终端</Text>
          <Text style={styles.status}>{terminalStatusLabel[state.status]}</Text>
        </View>
        <Pressable
          accessibilityLabel="关闭终端"
          accessibilityRole="button"
          onPress={() => {
            controller.close();
            onClose();
          }}
          style={styles.button}
        >
          <Text style={styles.buttonText}>关闭</Text>
        </Pressable>
      </View>
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      ) : null}
      {state.truncated ? (
        <Text style={styles.warning}>较早的终端输出已从本机内存中截断。</Text>
      ) : null}
      <ScrollView
        contentContainerStyle={styles.outputBody}
        style={styles.output}
        testID="computer-terminal-output"
      >
        <Text selectable style={styles.outputText}>
          {new TextDecoder().decode(state.output)}
        </Text>
      </ScrollView>
      <View style={styles.controls}>
        {controlKeys.map((item) => (
          <Pressable
            accessibilityLabel={item.accessibilityLabel}
            accessibilityRole="button"
            disabled={!ready}
            key={item.key}
            onPress={() => controller.sendControl(item.key)}
            style={styles.controlButton}
          >
            <Text style={styles.buttonText}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.commandRow}>
        <TextInput
          accessibilityLabel="终端命令"
          autoCapitalize="none"
          autoCorrect={false}
          editable={ready}
          onChangeText={setCommand}
          onSubmitEditing={() => {
            if (!command) return;
            controller.submitLine(command);
            setCommand("");
          }}
          placeholder="输入命令"
          style={styles.input}
          value={command}
        />
        <Pressable
          accessibilityLabel="发送终端命令"
          accessibilityRole="button"
          disabled={!ready || !command}
          onPress={() => {
            controller.submitLine(command);
            setCommand("");
          }}
          style={styles.sendButton}
        >
          <Text style={[styles.buttonText, styles.sendButtonText]}>发送</Text>
        </Pressable>
      </View>
    </View>
  );
}

const terminalStatusLabel: Record<TerminalControllerState["status"], string> = {
  closed: "终端已关闭",
  connecting: "正在连接终端…",
  error: "终端连接异常",
  ready: "终端已连接",
};

const controlKeys: Array<{
  accessibilityLabel: string;
  key: TerminalControlKey;
  label: string;
}> = [
  { accessibilityLabel: "终端 Ctrl-C", key: "ctrl_c", label: "Ctrl-C" },
  { accessibilityLabel: "终端 Tab", key: "tab", label: "Tab" },
  { accessibilityLabel: "终端方向键上", key: "arrow_up", label: "↑" },
  { accessibilityLabel: "终端方向键下", key: "arrow_down", label: "↓" },
  { accessibilityLabel: "终端方向键左", key: "arrow_left", label: "←" },
  { accessibilityLabel: "终端方向键右", key: "arrow_right", label: "→" },
];

const styles = StyleSheet.create((theme) => ({
  button: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionQuietSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    justifyContent: "center",
    minHeight: theme.recipes.control.height,
    paddingHorizontal: theme.spacing.md,
  },
  buttonText: {
    ...theme.semantic.typography.bodySmallEmphasis,
  },
  commandRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  controlButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionQuietSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    justifyContent: "center",
    minHeight: theme.recipes.control.height,
    minWidth: theme.recipes.terminalPanel.controlMinWidth,
  },
  controls: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing.xs,
  },
  error: {
    color: theme.semantic.color.statusDangerText,
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  input: {
    backgroundColor: theme.semantic.color.fieldSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    flex: 1,
    ...theme.terminal.textStyle,
    minHeight: theme.recipes.control.fieldHeight,
    paddingHorizontal: theme.spacing.md,
  },
  output: {
    backgroundColor: theme.terminal.surface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    flex: 1,
    minHeight: theme.recipes.terminalPanel.outputMinHeight,
  },
  outputBody: {
    minHeight: theme.recipes.terminalPanel.outputMinHeight,
    padding: theme.spacing.md,
  },
  outputText: {
    color: theme.terminal.text,
    ...theme.terminal.textStyle,
  },
  panel: {
    backgroundColor: theme.semantic.color.sectionSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.section,
    flex: 1,
    gap: theme.spacing.md,
    minHeight: 0,
    padding: theme.spacing.lg,
  },
  sendButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionTonalSurface,
    borderColor: theme.semantic.color.borderInteractive,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    justifyContent: "center",
    minHeight: theme.recipes.control.height,
    paddingHorizontal: theme.spacing.lg,
  },
  sendButtonText: {
    color: theme.semantic.color.actionTonalText,
  },
  status: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.navigationLabel,
  },
  title: {
    ...theme.semantic.typography.controlGlyph,
  },
  warning: {
    color: theme.semantic.color.statusWarningText,
    ...theme.semantic.typography.bodySmallEmphasis,
  },
}));
