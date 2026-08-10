import { useState } from "react";
import {
  ScrollView,
  Text,
  View,
} from "react-native";
import {StyleSheet} from "react-native-unistyles";

import { BrandMark } from "../components/brand-mark";
import {SystemButton} from "../primitives/system-button";
import {SystemField, SystemTextInput} from "../primitives/system-field";
import {SystemFeedback} from "../primitives/system-feedback";

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
            <SystemField
              error={displayNameError}
              label="显示名称"
              labelTone="primary"
            >
              <SystemTextInput
                autoComplete="name"
                invalid={Boolean(displayNameError)}
                onChangeText={setDisplayName}
                placeholder="你的名字"
                size="large"
                value={displayName}
              />
            </SystemField>
          ) : null}
          <SystemField
            error={emailError}
            label="邮箱"
            labelTone="primary"
          >
            <SystemTextInput
              autoCapitalize="none"
              autoComplete="email"
              invalid={Boolean(emailError)}
              keyboardType="email-address"
              onChangeText={setEmail}
              placeholder="name@example.com"
              size="large"
              testID="auth-email-input"
              value={email}
            />
          </SystemField>
          <SystemField
            error={passwordError}
            label="密码"
            labelTone="primary"
          >
            <SystemTextInput
              autoCapitalize="none"
              autoComplete="current-password"
              invalid={Boolean(passwordError)}
              onChangeText={setPassword}
              placeholder="至少 8 位密码"
              secureTextEntry
              size="large"
              value={password}
            />
          </SystemField>

          {error ? (
            <SystemFeedback kind="inline" message={error} tone="danger" />
          ) : null}

          <SystemButton
            align="stretch"
            busy={loading}
            label={mode === "login" ? "登录" : "注册并继续"}
            onPress={submit}
            variant="default"
          />

          <SystemButton
            align="center"
            label={mode === "login"
              ? "还没有账号？立即注册"
              : "已经有账号？返回登录"}
            onPress={() => {
              onDismissError?.();
              onModeChange?.(mode === "login" ? "register" : "login");
            }}
            variant="toolbar"
          />
        </View>
      </View>
    </ScrollView>
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
