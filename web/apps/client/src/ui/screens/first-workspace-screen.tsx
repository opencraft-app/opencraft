import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { BrandMark } from "../components/brand-mark";
import { WorkspaceSetupPresentation } from "../presentation";
import { raftTheme } from "../tokens";

export interface FirstWorkspaceInput {
  channelName: string;
  serverName: string;
  serverSlug: string;
  visibility: "private" | "public";
}

interface FirstWorkspaceScreenProps {
  error?: string | null;
  existingServerName?: string;
  loading?: boolean;
  onLogout(): void;
  onSubmit(input: FirstWorkspaceInput): void | Promise<void>;
  stage?: "channel" | "server" | null;
  viewportWidth?: number;
}

export function FirstWorkspaceScreen({
  error,
  existingServerName,
  loading = false,
  onLogout,
  onSubmit,
  stage = null,
}: FirstWorkspaceScreenProps) {
  const [channelName, setChannelName] = useState("general");
  const [serverName, setServerName] = useState("");
  const [serverSlug, setServerSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<"private" | "public">("public");

  function changeServerName(value: string): void {
    setServerName(value);
    if (!slugEdited) {
      setServerSlug(makeServerSlug(value));
    }
  }

  function changeServerSlug(value: string): void {
    setSlugEdited(true);
    setServerSlug(
      value
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-{2,}/g, "-")
        .slice(0, 63),
    );
  }

  function submit(): void {
    const name = serverName.trim();
    const slug = serverSlug.replace(/^-+|-+$/g, "");
    const channel = channelName.trim();
    if (!existingServerName && !name) {
      setValidationError("请输入 Server 名称");
      return;
    }
    if (!existingServerName && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
      setValidationError("Server 标识需要 2–63 位小写字母、数字或连字符");
      return;
    }
    if (!channel) {
      setValidationError("请输入首个 Channel 名称");
      return;
    }
    setValidationError(null);
    void onSubmit({
      channelName: channel,
      serverName: name,
      serverSlug: slug,
      visibility,
    });
  }

  const visibleError = validationError ?? error;
  const actionLabel = existingServerName
    ? "创建并进入 Channel"
    : "创建并进入 Server";
  const stageLabel =
    stage === "server"
      ? "正在创建 Server 与成员根群…"
      : stage === "channel"
        ? "正在创建首个 Channel…"
        : "正在准备工作空间…";
  const title = existingServerName
    ? "建立第一个对话空间"
    : "建立你的第一个 Server";
  const description = existingServerName
    ? `${existingServerName} 已创建。现在添加一个 Channel，即可开始 Human 与 Agent 协作。`
    : "Server 是成员、Agent 和对话的共同边界。创建完成后，我们会同时准备消息空间。";
  const setupFields = [
    ...(!existingServerName
      ? [
          {
            disabled: loading,
            id: "server-name",
            label: "Server 名称",
            onChange: changeServerName,
            placeholder: "例如：Agent Network",
            value: serverName,
          },
          {
            disabled: loading,
            id: "server-slug",
            label: "Server 标识",
            onChange: changeServerSlug,
            placeholder: "agent-network",
            value: serverSlug,
          },
        ]
      : []),
    {
      disabled: loading,
      id: "channel-name",
      label: "首个 Channel",
      onChange: setChannelName,
      placeholder: "general",
      value: channelName,
    },
    {
      disabled: loading,
      id: "visibility",
      label: "可见范围",
      onChange(value: string) {
        if (value === "public" || value === "private") {
          setVisibility(value);
        }
      },
      options: [
        { label: "公开", value: "public" },
        { label: "私密", value: "private" },
      ],
      value: visibility,
    },
  ];

  return (
    <WorkspaceSetupPresentation
      model={{
        description,
        ...(visibleError ? { error: visibleError } : {}),
        form: {
          actions: [
            {
              disabled: loading,
              id: "submit",
              kind: "primary",
              label: actionLabel,
              run: submit,
            },
            {
              disabled: loading,
              id: "logout",
              label: "退出当前账号",
              run: onLogout,
            },
          ],
          fields: setupFields,
          title: "创建工作空间",
        },
        stage: loading ? stageLabel : null,
        title,
      }}
    >
      <ScrollView
        contentContainerStyle={styles.page}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={styles.shell}
          testID="first-workspace-shell"
        >
          <View style={styles.setupHeader}>
            <BrandMark />
            <View style={styles.setupHeaderCopy}>
              <Text style={styles.title}>{title}</Text>
              <Text style={styles.copy}>{description}</Text>
            </View>
          </View>

          <View style={styles.formPanel}>
            {!existingServerName ? (
              <>
                <LabeledInput
                  accessibilityLabel="Server 名称"
                  autoComplete="organization"
                  label="Server 名称"
                  onChangeText={changeServerName}
                  placeholder="例如：Agent Network"
                  value={serverName}
                />
                <LabeledInput
                  accessibilityLabel="Server 标识"
                  autoCapitalize="none"
                  label="Server 标识"
                  onChangeText={changeServerSlug}
                  placeholder="agent-network"
                  value={serverSlug}
                />
              </>
            ) : (
              <View style={styles.existingServer}>
                <Text style={styles.existingLabel}>SERVER READY</Text>
                <Text style={styles.existingName}>{existingServerName}</Text>
              </View>
            )}

            <LabeledInput
              accessibilityLabel="首个 Channel"
              autoCapitalize="none"
              label="首个 Channel"
              onChangeText={setChannelName}
              placeholder="general"
              value={channelName}
            />

            <View style={styles.field}>
              <Text style={styles.label}>可见范围</Text>
              <View style={styles.visibilityRow}>
                <VisibilityButton
                  active={visibility === "public"}
                  label="公开"
                  onPress={() => setVisibility("public")}
                />
                <VisibilityButton
                  active={visibility === "private"}
                  label="私密"
                  onPress={() => setVisibility("private")}
                />
              </View>
              <Text style={styles.hint}>
                {visibility === "public"
                  ? "所有 Server 成员都能发现，并可自行加入。"
                  : "创建后再按需添加成员。"}
              </Text>
            </View>

            {visibleError ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {visibleError}
              </Text>
            ) : null}

            <Pressable
              accessibilityRole="button"
              disabled={loading}
              onPress={submit}
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.buttonPressed,
                loading && styles.buttonDisabled,
              ]}
            >
              {loading ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator
                    color={raftTheme.semantic.color.iconInverse}
                  />
                  <Text style={styles.primaryButtonText}>{stageLabel}</Text>
                </View>
              ) : (
                <Text style={styles.primaryButtonText}>{actionLabel}</Text>
              )}
            </Pressable>

            <Pressable
              accessibilityRole="button"
              disabled={loading}
              onPress={onLogout}
              style={styles.logoutButton}
            >
              <Text style={styles.logoutText}>退出当前账号</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </WorkspaceSetupPresentation>
  );
}

export function makeServerSlug(name: string): string {
  const readable = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  if (readable.length >= 2) {
    return readable;
  }

  let hash = 2_166_136_261;
  for (const character of name.trim()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  const suffix = (hash >>> 0).toString(36).padStart(6, "0").slice(0, 6);
  return `server-${suffix}`;
}

function LabeledInput(
  props: React.ComponentProps<typeof TextInput> & { label: string },
) {
  const { label, ...inputProps } = props;
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        {...inputProps}
        editable={inputProps.editable}
        placeholderTextColor={raftTheme.semantic.color.fieldPlaceholder}
        style={styles.input}
      />
    </View>
  );
}

function VisibilityButton({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityLabel={`${label} Channel`}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.visibilityButton, active && styles.visibilityButtonActive]}
    >
      <Text style={styles.visibilityText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  buttonDisabled: {
    opacity: theme.semantic.interaction.disabledOpacity,
  },
  buttonPressed: {
    opacity: theme.semantic.opacity.decorativeStrong,
    transform: [{ scale: theme.semantic.interaction.pressedScaleSubtle }],
  },
  copy: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.messageBody,
    maxWidth: theme.recipes.contentMeasure.readingMaxWidth,
  },
  error: {
    backgroundColor: theme.semantic.color.statusDangerSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    color: theme.semantic.color.statusDangerText,
    borderRadius: theme.semantic.radius.control,
    ...theme.semantic.typography.bodyCompactEmphasis,
    padding: theme.spacing.md,
  },
  existingLabel: {
    ...theme.semantic.typography.overline,
  },
  existingName: {
    ...theme.semantic.typography.dialogTitle,
  },
  existingServer: {
    backgroundColor: theme.semantic.color.statusPositiveSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.section,
    gap: theme.spacing.xs,
    padding: theme.spacing.lg,
  },
  field: {
    gap: theme.spacing.sm,
  },
  formPanel: {
    borderTopColor: theme.semantic.color.separator,
    borderTopWidth: theme.semantic.stroke.hairline,
    gap: theme.spacing.lg,
    minWidth: 0,
    paddingTop: theme.spacing.xl,
    width: "100%",
  },
  hint: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodySmall,
  },
  input: {
    backgroundColor: theme.semantic.color.fieldSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.messageBody,
    minHeight: theme.recipes.authWorkspace.controlHeight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.md,
  },
  label: {
    ...theme.semantic.typography.eyebrow,
    textTransform: "uppercase",
  },
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing.md,
    justifyContent: "center",
  },
  logoutButton: {
    alignSelf: "center",
    padding: theme.spacing.sm,
  },
  logoutText: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.bodyCompactEmphasis,
    textDecorationLine: "underline",
  },
  page: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    flexGrow: 1,
    justifyContent: "center",
    padding: theme.spacing.xl,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionPrimarySurface,
    borderColor: theme.semantic.color.actionPrimarySurface,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    justifyContent: "center",
    minHeight: theme.recipes.authWorkspace.primaryActionHeight,
    paddingHorizontal: theme.spacing.lg,
  },
  primaryButtonText: {
    color: theme.semantic.color.actionPrimaryText,
    ...theme.semantic.typography.bodyEmphasis,
  },
  shell: {
    alignItems: "stretch",
    alignSelf: "center",
    backgroundColor: theme.semantic.color.sectionSurface,
    borderColor: theme.semantic.color.borderControl,
    borderRadius: theme.semantic.radius.section,
    borderWidth: theme.semantic.stroke.hairline,
    flexDirection: "column",
    gap: theme.spacing.xl,
    maxWidth: theme.recipes.authWorkspace.compactPanelMaxWidth,
    padding: theme.spacing.xl,
    width: "100%",
  },
  setupHeader: {
    alignItems: "flex-start",
    gap: theme.spacing.lg,
  },
  setupHeaderCopy: {
    gap: theme.spacing.sm,
  },
  title: {
    ...theme.semantic.typography.onboardingTitle,
  },
  visibilityButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.surfaceMuted,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    flex: 1,
    minHeight: theme.recipes.control.height,
    justifyContent: "center",
  },
  visibilityButtonActive: {
    backgroundColor: theme.semantic.color.selectionSurface,
    borderColor: theme.semantic.color.borderSelected,
  },
  visibilityRow: {
    flexDirection: "row",
    gap: theme.spacing.sm,
  },
  visibilityText: {
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
}));
