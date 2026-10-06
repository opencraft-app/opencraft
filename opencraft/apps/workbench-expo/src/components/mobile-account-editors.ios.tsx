import { useEffect, useReducer, useRef } from "react";
import { Button } from "heroui-native";
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  ACCOUNT_NICKNAME_MAX_LENGTH,
  accountOperations,
  isValidAccountNickname,
  isValidSafetyPhone,
  normalizeSafetyPhone,
  parsePhoneCodeResponse,
} from "@opencraft/mobile-account-sdk";
import { LIGHTVELA_REGIONS, type LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";

import { mobileAccount } from "../runtime/mobile-account-instance";
import { accountEditorTransition, createAccountEditorState } from "../runtime/mobile-account-editor-model";
import { type MobileLanguage } from "../runtime/mobile-language";

type Editor = "nickname" | "phone";
type Operation = ReturnType<typeof accountOperations.updateNickname>
  | ReturnType<typeof accountOperations.sendPhoneCode>
  | ReturnType<typeof accountOperations.verifyPhone>;

const copy = {
  "zh-CN": { nickname: "修改昵称", phone: "绑定安全手机", changePhone: "修改绑定手机", nameLabel: "昵称", phoneLabel: "中国大陆手机号", codeLabel: "短信验证码", currentPhone: "当前绑定", send: "获取验证码", sending: "发送中…", resend: "重新发送", save: "保存", cancel: "取消", invalidName: "请输入不超过 20 字的昵称", invalidPhone: "请输入正确的中国大陆手机号", invalidCode: "请输入短信验证码", failed: "操作未完成，请稍后重试", unauthorized: "登录已失效，请重新登录", phoneUsed: "该手机号已绑定其他账号", codeExpired: "验证码已过期，请重新获取", codeInvalid: "验证码不正确，请检查后重试", codeMissing: "请先获取短信验证码", syncFailed: "安全手机同步失败，请稍后重试" },
  "en-US": { nickname: "Edit name", phone: "Bind phone", changePhone: "Change phone", nameLabel: "Display name", phoneLabel: "Mainland China phone", codeLabel: "SMS code", currentPhone: "Current phone", send: "Send code", sending: "Sending…", resend: "Resend", save: "Save", cancel: "Cancel", invalidName: "Enter a name of up to 20 characters", invalidPhone: "Enter a valid mainland China phone number", invalidCode: "Enter the SMS code", failed: "Could not complete this action. Try again later", unauthorized: "Your session has expired. Sign in again", phoneUsed: "This phone is linked to another account", codeExpired: "The code expired. Request another", codeInvalid: "The code is incorrect", codeMissing: "Request an SMS code first", syncFailed: "Could not sync the phone. Try again later" },
} as const;

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(24, 18, 34, 0.38)" },
  panel: { backgroundColor: "#fff", borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 24, paddingTop: 26, paddingBottom: 30 },
  title: { color: "#211b29", fontSize: 23, fontWeight: "700", marginBottom: 22 },
  label: { color: "#534b5b", fontSize: 14, fontWeight: "600", marginBottom: 8 },
  current: { color: "#77717f", fontSize: 14, marginBottom: 18 },
  input: { borderWidth: 1, borderColor: "#e4deea", borderRadius: 14, minHeight: 52, paddingHorizontal: 16, color: "#211b29", backgroundColor: "#faf9fc", fontSize: 16 },
  field: { marginBottom: 20 },
  phoneRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  phoneInput: { flex: 1 },
  sendButton: { minWidth: 112, minHeight: 52 },
  error: { color: "#b53e54", fontSize: 13, marginBottom: 14 },
  actions: { flexDirection: "row", gap: 10, marginTop: 4 },
  action: { flex: 1, minHeight: 52 },
});

async function accountRequest(region: LightVelaRegion, operation: Operation): Promise<unknown> {
  const token = await mobileAccount.webSessionToken();
  if (!token) throw { status: 401 };
  const response = await fetch(`${LIGHTVELA_REGIONS[region].apiBase}${operation.path}`, {
    method: operation.method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(operation.body),
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { code?: unknown; error?: unknown } | null;
    const code = typeof payload?.code === "string" ? payload.code : payload?.error;
    throw { status: response.status, code: typeof code === "string" ? code : undefined };
  }
  return response.json();
}

export function MobileAccountEditor({ editor, currentName, currentPhone, region, language, onClose, onSaved }: {
  readonly editor: Editor;
  readonly currentName: string;
  readonly currentPhone: string | null;
  readonly region: LightVelaRegion;
  readonly language: MobileLanguage;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const t = copy[language];
  const [form, dispatch] = useReducer(accountEditorTransition, currentName, createAccountEditorState);
  const requestSerial = useRef(0);
  const pendingRequest = useRef(false);
  const { name, phone, code, cooldown, error } = form;
  const busy = form.pending?.kind === "save";
  const sending = form.pending?.kind === "code";

  useEffect(() => { dispatch({ type: "server-name", name: currentName }); }, [currentName]);

  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => dispatch({ type: "tick" }), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const mapError = (cause: unknown) => {
    const failure = cause as { status?: number; code?: string };
    if (failure.status === 401) return t.unauthorized;
    switch (failure.code) {
      case "invalid_name": return t.invalidName;
      case "invalid_phone": return t.invalidPhone;
      case "phone_in_use": return t.phoneUsed;
      case "sms_code_not_found": return t.codeMissing;
      case "sms_code_expired": return t.codeExpired;
      case "invalid_sms_code": return t.codeInvalid;
      case "shadow_binding_failed":
      case "shadow_binding_incomplete": return t.syncFailed;
      default: return t.failed;
    }
  };

  const sendCode = async () => {
    if (!isValidSafetyPhone(phone) || pendingRequest.current || cooldown) return;
    const id = ++requestSerial.current;
    pendingRequest.current = true;
    dispatch({ type: "request-start", id, kind: "code", input: phone });
    try {
      const payload = await accountRequest(region, accountOperations.sendPhoneCode(phone));
      dispatch({ type: "request-success", id, cooldown: Math.max(1, parsePhoneCodeResponse(payload).cooldownSeconds || 60) });
    } catch (cause) { dispatch({ type: "request-failure", id, error: mapError(cause) }); }
    finally { pendingRequest.current = false; }
  };

  const save = async () => {
    if (pendingRequest.current) return;
    if (editor === "nickname" && !isValidAccountNickname(name)) { dispatch({ type: "error", error: t.invalidName }); return; }
    if (editor === "phone" && !isValidSafetyPhone(phone)) { dispatch({ type: "error", error: t.invalidPhone }); return; }
    if (editor === "phone" && code.trim().length < 4) { dispatch({ type: "error", error: t.invalidCode }); return; }
    const id = ++requestSerial.current;
    pendingRequest.current = true;
    dispatch({ type: "request-start", id, kind: "save", input: editor === "nickname" ? name : phone });
    try {
      await accountRequest(region, editor === "nickname" ? accountOperations.updateNickname(name) : accountOperations.verifyPhone(phone, code));
      dispatch({ type: "request-success", id });
      onSaved();
    } catch (cause) { dispatch({ type: "request-failure", id, error: mapError(cause) }); }
    finally { pendingRequest.current = false; }
  };

  return <Modal visible transparent animationType="slide" onRequestClose={onClose}>
    <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <SafeAreaView edges={["bottom"]} style={styles.panel}>
        <Text style={styles.title}>{editor === "nickname" ? t.nickname : currentPhone ? t.changePhone : t.phone}</Text>
        {editor === "nickname" ? <View style={styles.field}>
          <Text style={styles.label}>{t.nameLabel}</Text>
          <TextInput style={styles.input} value={name} onChangeText={value => dispatch({ type: "name", value })} editable={!busy} maxLength={ACCOUNT_NICKNAME_MAX_LENGTH} autoCapitalize="words" accessibilityLabel={t.nameLabel} />
        </View> : <>
          {currentPhone ? <Text style={styles.current}>{t.currentPhone}: {currentPhone}</Text> : null}
          <View style={styles.field}>
            <Text style={styles.label}>{t.phoneLabel}</Text>
            <View style={styles.phoneRow}>
              <TextInput style={[styles.input, styles.phoneInput]} value={phone} onChangeText={value => dispatch({ type: "phone", value: normalizeSafetyPhone(value).slice(0, 11) })} editable={!busy && !sending} keyboardType="phone-pad" autoComplete="tel" accessibilityLabel={t.phoneLabel} />
              <Button style={styles.sendButton} variant="secondary" isDisabled={!isValidSafetyPhone(phone) || sending || busy || cooldown > 0} onPress={() => void sendCode()}>
                {sending ? t.sending : cooldown > 0 ? `${t.resend} ${cooldown}s` : t.send}
              </Button>
            </View>
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>{t.codeLabel}</Text>
            <TextInput style={styles.input} value={code} onChangeText={value => dispatch({ type: "code", value: value.replace(/\D/g, "").slice(0, 8) })} editable={!busy} keyboardType="number-pad" autoComplete="sms-otp" accessibilityLabel={t.codeLabel} />
          </View>
        </>}
        {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
        <View style={styles.actions}>
          <Button style={styles.action} variant="secondary" isDisabled={busy || sending} onPress={onClose}>{t.cancel}</Button>
          <Button style={styles.action} isDisabled={busy || sending || (editor === "nickname" ? !isValidAccountNickname(name) : !isValidSafetyPhone(phone) || code.trim().length < 4)} onPress={() => void save()}>{t.save}</Button>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  </Modal>;
}
