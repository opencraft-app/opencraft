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
import { velaTheme } from "../tokens";

interface LoginInput {
  email: string;
  password: string;
}

interface RegisterInput extends LoginInput {
  displayName: string;
}

interface AuthScreenProps {
  error?: string | null;
  loading?: boolean;
  mode: "login" | "register";
  onDismissError?(): void;
  onModeChange?(mode: "login" | "register"): void;
  onSubmit(input: LoginInput | RegisterInput): void;
}

export function AuthScreen({
  error,
  loading = false,
  mode,
  onDismissError,
  onModeChange,
  onSubmit,
}: AuthScreenProps) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [validationAttempted, setValidationAttempted] = useState(false);
  const displayNameError =
    validationAttempted && mode === "register"
      ? validateDisplayName(displayName)
      : null;
  const emailError = validationAttempted ? validateEmail(email) : null;
  const passwordError = validationAttempted ? validatePassword(password) : null;

  function submit(): void {
    setValidationAttempted(true);
    if (
      validateEmail(email) ||
      validatePassword(password) ||
      (mode === "register" && validateDisplayName(displayName))
    ) {
      return;
    }
    const base = {
      email: email.trim(),
      password,
    };
    onSubmit(
      mode === "register" ? { ...base, displayName: displayName.trim() } : base,
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.shell}>
        <BrandMark />
        <View style={styles.formPanel} testID="auth-form-panel">
          <View style={styles.formHeading}>
            <View style={styles.formHeadingCopy}>
              <Text style={styles.title}>
                {mode === "login" ? "欢迎回来" : "建立你的身份"}
              </Text>
              <Text style={styles.subtitle}>
                {mode === "login"
                  ? "登录后继续进入 Server。"
                  : "自然人将获得一个全局 IM 身份。"}
              </Text>
            </View>
          </View>

          {mode === "register" ? (
            <LabeledInput
              autoComplete="name"
              error={displayNameError}
              label="显示名称"
              onChangeText={setDisplayName}
              placeholder="你的名字"
              value={displayName}
            />
          ) : null}
          <LabeledInput
            autoCapitalize="none"
            autoComplete="email"
            error={emailError}
            keyboardType="email-address"
            label="邮箱"
            onChangeText={setEmail}
            placeholder="name@example.com"
            testID="auth-email-input"
            value={email}
          />
          <LabeledInput
            autoCapitalize="none"
            autoComplete="current-password"
            error={passwordError}
            label="密码"
            onChangeText={setPassword}
            placeholder="至少 8 位密码"
            secureTextEntry
            value={password}
          />

          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
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
              <ActivityIndicator color={velaTheme.semantic.color.iconInverse} />
            ) : (
              <Text style={styles.primaryButtonText}>
                {mode === "login" ? "登录" : "注册并继续"}
              </Text>
            )}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => {
              onDismissError?.();
              onModeChange?.(mode === "login" ? "register" : "login");
            }}
            style={styles.modeButton}
          >
            <Text style={styles.modeButtonText}>
              {mode === "login"
                ? "还没有账号？立即注册"
                : "已经有账号？返回登录"}
            </Text>
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

function LabeledInput(
  props: React.ComponentProps<typeof TextInput> & {
    error?: string | null;
    label: string;
  },
) {
  const { error, label, style, ...inputProps } = props;
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        {...inputProps}
        placeholderTextColor={velaTheme.semantic.color.fieldPlaceholder}
        style={[styles.input, error && styles.inputInvalid, style]}
      />
      {error ? (
        <Text accessibilityRole="alert" style={styles.fieldError}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function validateDisplayName(value: string): string | null {
  const length = Array.from(value.trim()).length;
  if (length === 0) return "请输入显示名称。";
  if (length > 100) return "显示名称不能超过 100 个字符。";
  return null;
}

function validateEmail(value: string): string | null {
  const email = value.trim();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/u.test(email)) {
    return "请输入有效的邮箱地址。";
  }
  return null;
}

function validatePassword(value: string): string | null {
  const length = Array.from(value).length;
  if (length < 8) return "密码至少需要 8 位。";
  if (length > 200) return "密码不能超过 200 位。";
  return null;
}

const styles = StyleSheet.create((theme) => ({
  buttonDisabled: {
    opacity: theme.semantic.interaction.disabledOpacity,
  },
  buttonPressed: {
    opacity: theme.semantic.opacity.decorativeStrong,
    transform: [{ scale: theme.semantic.interaction.pressedScaleSubtle }],
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
  field: {
    gap: theme.spacing.sm,
  },
  fieldError: {
    color: theme.semantic.color.statusDangerText,
    ...theme.semantic.typography.bodySmall,
  },
  formHeading: {
    alignItems: "flex-start",
    gap: theme.spacing.md,
    marginBottom: theme.spacing.md,
  },
  formHeadingCopy: {
    alignItems: "flex-start",
    gap: theme.spacing.xs,
  },
  formPanel: {
    backgroundColor: theme.semantic.color.sectionSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.section,
    gap: theme.spacing.lg,
    justifyContent: "center",
    maxWidth: theme.recipes.contentMeasure.readingMaxWidth,
    padding: theme.recipes.authWorkspace.cardPadding,
    width: "100%",
  },
  input: {
    backgroundColor: theme.semantic.color.fieldSurface,
    borderColor: theme.semantic.color.borderControl,
    borderWidth: theme.semantic.stroke.hairline,
    borderRadius: theme.semantic.radius.control,
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.lead,
    minHeight: theme.recipes.authWorkspace.controlHeight,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  },
  inputInvalid: {
    borderColor: theme.semantic.color.borderDangerStrong,
  },
  label: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyCompactEmphasis,
  },
  modeButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: theme.recipes.authWorkspace.controlHeight,
  },
  modeButtonText: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.bodyCompactEmphasis,
    textDecorationLine: "underline",
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: theme.semantic.color.actionPrimarySurface,
    borderColor: theme.semantic.color.actionPrimarySurface,
    borderRadius: theme.semantic.radius.control,
    borderWidth: theme.semantic.stroke.hairline,
    justifyContent: "center",
    minHeight: theme.recipes.authWorkspace.primaryActionHeight,
  },
  primaryButtonText: {
    color: theme.semantic.color.actionPrimaryText,
    ...theme.semantic.typography.messageBody,
  },
  scroll: {
    backgroundColor: theme.semantic.color.surfaceSubtle,
    flexGrow: 1,
    justifyContent: "center",
    padding: theme.recipes.authWorkspace.desktopPadding,
  },
  shell: {
    alignItems: "flex-start",
    alignSelf: "center",
    flexDirection: "column",
    gap: theme.spacing.xl,
    justifyContent: "center",
    maxWidth: theme.recipes.authWorkspace.compactPanelMaxWidth,
    position: "relative",
    width: "100%",
  },
  subtitle: {
    color: theme.semantic.color.textMuted,
    ...theme.semantic.typography.body,
    textAlign: "left",
  },
  title: {
    color: theme.semantic.color.textPrimary,
    ...theme.semantic.typography.detailTitle,
    textAlign: "left",
  },
}));
