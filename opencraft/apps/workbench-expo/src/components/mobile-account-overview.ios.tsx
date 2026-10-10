import { useEffect, useRef, useState } from "react";
import { Button } from "heroui-native";
import { Image as CachedImage } from "expo-image";
import * as Network from "expo-network";
import { onlineManager } from "@tanstack/react-query";
import { setStringAsync } from "expo-clipboard";
import { ActivityIndicator, Alert, AppState, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import type { AccountDisplaySnapshot } from "@opencraft/mobile-account-sdk/display-cache";
import {
  parseReferralOverview,
  parseReferralStats,
  projectAccountOverview,
  type AccountOverviewModel,
  type ReferralOverview,
  type ReferralStats,
} from "@opencraft/mobile-account-sdk";
import { LIGHTVELA_REGIONS, type LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";
import { nativeTokens } from "@opencraft/design-system/tokens.native";

import { mobileAccount } from "../runtime/mobile-account-instance";
import { mobileAccountDisplayCache } from "../runtime/mobile-account-display-cache.native";
import { fetchMobileAccountProfile, mobileAccountQueryClient } from "../runtime/mobile-account-query.native";
import { mobileDeveloperLog } from "../runtime/mobile-developer-log.ios";
import { AvatarUploadError, pickAndUploadAvatar } from "../runtime/mobile-account-avatar.ios";
import { mobileLanguageCopy, type MobileLanguage } from "../runtime/mobile-language";
import { MobileAccountEditor } from "./mobile-account-editors.ios";
import { MobileSettingsInline } from "./mobile-settings-modal.ios";

type ReferralState =
  | { readonly status: "disabled" | "loading" | "error" }
  | { readonly status: "ready"; readonly overview: ReferralOverview; readonly stats: ReferralStats };

const copy = {
  "zh-CN": { caption: "你的 LightVela 身份", title: "我的账号", profile: "个人资料", email: "邮箱", phone: "手机", id: "账号 ID", empty: "未设置", pending: "审核中", verification: "实名认证", verified: "已认证", "needs-review": "需继续认证", syncing: "实名同步中", "sync-failed": "实名同步失败", unverified: "未认证", "not-applicable": "", checking: "正在核对", details: "管理账号", editName: "修改昵称", editPhone: "修改手机", bindPhone: "绑定手机", verifyIdentity: "去认证", manageIdentity: "查看认证", editAvatar: "更换头像", avatarTooLarge: "图片过大，请换一张照片", avatarInvalid: "无法读取这张图片", avatarUnavailable: "头像服务暂时不可用", avatarError: "头像上传失败，请重试", copy: "复制", copied: "已复制", copyError: "复制失败，可长按账号 ID", signOut: "退出登录", signOutTitle: "退出 LightVela？", signOutBody: "退出后，下次使用需要重新登录。", cancel: "取消", signOutError: "退出失败，请重试", invite: "邀请返利", inviteDetail: "分享邀请链接，查看邀请奖励", share: "分享邀请链接", successful: "成功邀请", granted: "已发积分", pendingRewards: "待发奖励", inviteError: "邀请信息暂时无法加载", retry: "重试", loadError: "暂时无法打开账号", refreshing: "正在更新账号资料", updateError: "账号暂时无法更新" },
  "en-US": { caption: "Your LightVela identity", title: "My account", profile: "Profile", email: "Email", phone: "Phone", id: "Account ID", empty: "Not set", pending: "Under review", verification: "Verification", verified: "Verified", "needs-review": "Continue verification", syncing: "Verification syncing", "sync-failed": "Verification sync failed", unverified: "Not verified", "not-applicable": "", checking: "Checking", details: "Manage account", editName: "Edit name", editPhone: "Change phone", bindPhone: "Bind phone", verifyIdentity: "Verify identity", manageIdentity: "View verification", editAvatar: "Change photo", avatarTooLarge: "The image is too large. Choose another", avatarInvalid: "Could not read this image", avatarUnavailable: "Profile photos are temporarily unavailable", avatarError: "Could not upload the photo. Try again", copy: "Copy", copied: "Copied", copyError: "Copy failed. Touch and hold the account ID", signOut: "Sign out", signOutTitle: "Sign out of LightVela?", signOutBody: "You will need to sign in next time.", cancel: "Cancel", signOutError: "Could not sign out. Try again", invite: "Invite friends", inviteDetail: "Share your invite link and track rewards", share: "Share invite link", successful: "Friends joined", granted: "Credits granted", pendingRewards: "Pending rewards", inviteError: "Invites are temporarily unavailable", retry: "Try again", loadError: "Could not open your account", refreshing: "Refreshing your account", updateError: "Could not refresh your account" },
} as const;

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 22, paddingBottom: 42, backgroundColor: nativeTokens.material.canvas },
  caption: { color: nativeTokens.color.text.tertiary, fontSize: 12, fontWeight: "600", letterSpacing: 0.6 },
  title: { color: nativeTokens.color.text.primary, fontSize: 32, fontWeight: "700", marginTop: 6 },
  identity: { flexDirection: "row", alignItems: "center", marginTop: 24, padding: 18, borderRadius: 22, backgroundColor: nativeTokens.material.content, borderWidth: 1, borderColor: nativeTokens.color.border.soft },
  avatar: { width: 60, height: 60, borderRadius: 20 },
  avatarFallback: { width: 60, height: 60, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: nativeTokens.color.accent.purple },
  avatarLetter: { color: "#fff", fontSize: 28, fontWeight: "700" },
  identityName: { flex: 1, marginLeft: 16 },
  name: { color: nativeTokens.color.text.primary, fontSize: 21, lineHeight: 29, fontWeight: "700" },
  pending: { color: "#b36b20", fontSize: 12, marginTop: 2 },
  avatarEdit: { alignSelf: "flex-start", minHeight: 34, marginTop: 4, paddingHorizontal: 0 },
  idValue: { flexDirection: "row", alignItems: "center", gap: 10 },
  idText: { flex: 1 },
  inlineError: { color: "#b53e54", fontSize: 13, lineHeight: 19, marginTop: 10 },
  card: { marginTop: 18, paddingHorizontal: 18, paddingTop: 18, paddingBottom: 16, borderRadius: 22, backgroundColor: nativeTokens.material.content, borderWidth: 1, borderColor: nativeTokens.color.border.soft },
  cardTitle: { color: nativeTokens.color.text.primary, fontSize: 18, fontWeight: "700" },
  cardDetail: { color: nativeTokens.color.text.secondary, fontSize: 13, lineHeight: 19, marginTop: 4 },
  row: { paddingVertical: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: nativeTokens.material.separator },
  rowLabel: { color: nativeTokens.color.text.secondary, fontSize: 13, lineHeight: 19 },
  rowValue: { color: nativeTokens.color.text.primary, fontSize: 16, lineHeight: 23, marginTop: 4 },
  stats: { flexDirection: "row", justifyContent: "space-between", gap: 8, marginTop: 14, marginBottom: 18 },
  stat: { flex: 1 },
  statValue: { color: nativeTokens.color.text.primary, fontSize: 20, fontWeight: "700", marginTop: 4 },
  action: { marginTop: 16, minHeight: 46, borderRadius: 14 },
  primaryAction: { marginTop: 18, minHeight: 50, borderRadius: 16, backgroundColor: nativeTokens.color.accent.purple },
  actionLabel: { color: "#fff", fontWeight: "700", fontSize: 16 },
  editActions: { flexDirection: "row", gap: 8, marginTop: 16 },
  editAction: { flex: 1, minHeight: 46 },
  signOut: { marginTop: 16, minHeight: 48 },
  signOutLabel: { color: "#b53e54", fontWeight: "600" },
  skeletonAvatar: { width: 60, height: 60, borderRadius: 20, backgroundColor: nativeTokens.material.grouped },
  skeletonLine: { height: 16, borderRadius: 8, backgroundColor: nativeTokens.material.grouped },
  skeletonRow: { height: 65, justifyContent: "center", gap: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: nativeTokens.material.separator },
  skeletonAction: { flex: 1, height: 46, borderRadius: 14, backgroundColor: nativeTokens.material.grouped },
});

function AccountRow({ label, value }: { readonly label: string; readonly value: string }) {
  return <View style={styles.row}><Text style={styles.rowLabel}>{label}</Text><Text style={styles.rowValue}>{value}</Text></View>;
}

function AccountAvatar({ url, name, cacheKey }: { readonly url: string | null; readonly name: string; readonly cacheKey: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url, cacheKey]);
  return url && !failed
    ? <CachedImage source={{ uri: url, cacheKey }} cachePolicy="memory-disk" style={styles.avatar} onError={() => setFailed(true)} />
    : <View style={styles.avatarFallback}><Text style={styles.avatarLetter}>{name.slice(0, 1).toUpperCase()}</Text></View>;
}

async function referralData(base: string, token: string, path: string, method: "GET" | "POST") {
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { code?: unknown } | null;
    const error = new Error(`Referral request failed (${response.status})`) as Error & { status: number; code?: string };
    error.status = response.status;
    if (typeof payload?.code === "string") error.code = payload.code;
    throw error;
  }
  const payload = await response.json() as { data?: unknown };
  return payload.data;
}

export function MobileAccountOverview({ region, accountScope, language, onOpenDetails, onOpenRealname, onOpenBilling, onSignOut }: {
  readonly region: LightVelaRegion;
  readonly accountScope: string;
  readonly language: MobileLanguage;
  readonly onOpenDetails: () => void;
  readonly onOpenRealname: () => void;
  readonly onOpenBilling: () => void;
  readonly onSignOut: () => Promise<void>;
}) {
  const [model, setModel] = useState<AccountOverviewModel | null>(() => mobileAccountQueryClient.getQueryData<AccountOverviewModel>(["account", "overview", accountScope]) ?? null);
  const [display, setDisplay] = useState<AccountDisplaySnapshot | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(true);
  const [currentVerified, setCurrentVerified] = useState(false);
  const [referral, setReferral] = useState<ReferralState>({ status: "disabled" });
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<"nickname" | "phone" | null>(null);
  const [phoneProofEnabled, setPhoneProofEnabled] = useState(region === "cn");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarGeneration, setAvatarGeneration] = useState(0);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const lastRefreshAt = useRef(Date.now());
  const hasCurrentModel = useRef(false);
  useEffect(() => {
    let connected = true;
    const refresh = (force = false) => {
      if (AppState.currentState !== "active" || (!force && Date.now() - lastRefreshAt.current < 30_000)) return;
      lastRefreshAt.current = Date.now();
      setRevision(value => value + 1);
    };
    const app = AppState.addEventListener("change", state => { if (state === "active") refresh(); });
    const network = Network.addNetworkStateListener(state => {
      const next = state.isInternetReachable ?? state.isConnected ?? true;
      if (!connected && next) refresh(true);
      connected = next;
    });
    return () => { app.remove(); network.remove(); };
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    let active = true;
    lastRefreshAt.current = Date.now();
    setRefreshing(true);
    void (async () => {
      const token = await mobileAccount.webSessionToken();
      if (!token) throw new Error("Session expired");
      const scope = accountScope;
      const cachedModel = mobileAccountQueryClient.getQueryData<AccountOverviewModel>(["account", "overview", scope]);
      if (active && !hasCurrentModel.current && cachedModel && mobileAccount.getSnapshot().region === region && await mobileAccount.webSessionToken() === token) {
        setModel(cachedModel);
        setCurrentVerified(false);
        mobileDeveloperLog.log("account.profile.cache.hit");
      }
      void mobileAccountDisplayCache.read(region, token).then(async cached => {
        if (active && cached && mobileAccount.getSnapshot().region === region && await mobileAccount.webSessionToken() === token) {
          setDisplay(cached);
          mobileDeveloperLog.log("account.profile.display-cache.hit");
        }
      });
      if (!onlineManager.isOnline()) throw new Error("Offline");
      const base = LIGHTVELA_REGIONS[region].apiBase;
      const profile = await mobileAccountQueryClient.fetchQuery({
        queryKey: ["account", "profile", scope],
        staleTime: 0,
        queryFn: async () => {
          try { return await fetchMobileAccountProfile(region, token); }
          catch (cause) {
            if ((cause as { status?: unknown }).status !== 401) throw cause;
            if (active && mobileAccount.getSnapshot().region === region && await mobileAccount.webSessionToken() === token) {
              await mobileAccount.signOut();
            }
            throw cause;
          }
        },
      });
      if (!active || mobileAccount.getSnapshot().region !== region || await mobileAccount.webSessionToken() !== token) return;
      let phoneVerificationEnabled = region === "cn";
      let referralEnabled = false;
      try {
        const config = await fetch(`${base}/v1/frontend/runtime-config`, { cache: "no-store" });
        if (config.ok) {
          const value = await config.json() as { features?: { realnamePhoneVerificationEnabled?: unknown; referralEnabled?: unknown } };
          if (typeof value.features?.realnamePhoneVerificationEnabled === "boolean") {
            phoneVerificationEnabled = value.features.realnamePhoneVerificationEnabled;
          }
          referralEnabled = value.features?.referralEnabled === true;
        }
      } catch { /* Keep documented defaults if runtime configuration is unavailable. */ }
      const nextModel = projectAccountOverview(profile, region, phoneVerificationEnabled);
      setPhoneProofEnabled(phoneVerificationEnabled);
      mobileAccountQueryClient.setQueryData(["account", "overview", scope], nextModel);
      hasCurrentModel.current = true;
      setModel(nextModel);
      setDisplay(null);
      setError(false);
      setCurrentVerified(true);
      setRefreshing(false);
      mobileDeveloperLog.log("account.profile.refresh.succeeded");
      void mobileAccountDisplayCache.write(region, token, nextModel).catch(() => undefined);
      if (avatarGeneration > 0 && nextModel.avatarUrl) void CachedImage.prefetch(nextModel.avatarUrl, "disk").catch(() => undefined);
      if (!active) return;
      if (!referralEnabled) { setReferral({ status: "disabled" }); return; }
      setReferral(previous => previous.status === "ready" ? previous : { status: "loading" });
      try {
        const [overview, stats] = await Promise.all([
          referralData(base, token, "/v1/referrals/me/code", "POST"),
          referralData(base, token, "/v1/referrals/me/stats", "GET"),
        ]);
        if (active) setReferral({ status: "ready", overview: parseReferralOverview(overview), stats: parseReferralStats(stats) });
      } catch (cause) {
        const failure = cause as { status?: unknown; code?: unknown };
        if (active) setReferral(previous => failure.status === 404 || failure.code === "campaign_inactive"
          ? { status: "disabled" }
          : previous.status === "ready" ? previous : { status: "error" });
      }
    })().catch(cause => {
      if (active) {
        if ((cause as { status?: unknown }).status === 401) { hasCurrentModel.current = false; setModel(null); setCurrentVerified(false); }
        setError(true);
        setRefreshing(false);
        mobileDeveloperLog.log("account.profile.refresh.failed");
      }
    });
    return () => { active = false; };
  }, [accountScope, region, revision]);

  const t = copy[language];
  const siteCopy = mobileLanguageCopy(language);
  const changeAvatar = async () => {
    if (avatarBusy) return;
    setAvatarBusy(true);
    setAvatarError(null);
    try {
      if (await pickAndUploadAvatar(region)) {
        // The profile endpoint can reuse the same URL after an upload.
        await Promise.all([
          CachedImage.clearDiskCache().catch(() => undefined),
          CachedImage.clearMemoryCache().catch(() => undefined),
        ]);
        setAvatarGeneration(value => value + 1);
        await mobileAccountQueryClient.invalidateQueries({ queryKey: ["account", "profile"] });
        setRevision(value => value + 1);
      }
    } catch (cause) {
      const code = cause instanceof AvatarUploadError ? cause.code : "";
      setAvatarError(code === "avatar_too_large" ? t.avatarTooLarge
        : code === "avatar_invalid" ? t.avatarInvalid
          : code === "avatar_unavailable" ? t.avatarUnavailable : t.avatarError);
    } finally { setAvatarBusy(false); }
  };
  const copyId = async (id: string) => {
    try {
      if (!await setStringAsync(id)) throw new Error("Clipboard unavailable");
      setCopied(true);
      setCopyError(false);
    } catch { setCopyError(true); }
  };
  const confirmSignOut = () => {
    Alert.alert(t.signOutTitle, t.signOutBody, [
      { text: t.cancel, style: "cancel" },
      { text: t.signOut, style: "destructive", onPress: () => {
        if (signingOut) return;
        setSigningOut(true);
        setSignOutError(false);
        void onSignOut().catch(() => { setSignOutError(true); setSigningOut(false); });
      } },
    ]);
  };
  if (!model) return <ScrollView style={{ flex: 1, backgroundColor: nativeTokens.material.canvas }} contentContainerStyle={styles.content} accessibilityState={{ busy: refreshing }}>
    <Text style={styles.caption}>{t.caption}</Text><Text style={styles.title}>{t.title}</Text>
    <View style={styles.identity}>
      {display ? <AccountAvatar url={display.avatarUrl} name={display.displayName} cacheKey={display.avatarUrl ?? display.displayName} /> : <View style={styles.skeletonAvatar} />}
      <View style={styles.identityName}>{display ? <Text style={styles.name}>{display.displayName}</Text> : <View style={[styles.skeletonLine, { width: "60%", height: 24 }]} />}</View>
    </View>
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{t.profile}</Text>
      {[t.email, t.phone, t.id, ...(region === "cn" ? [t.verification] : [])].map(label => <View key={label} style={styles.skeletonRow}>
        <Text style={styles.rowLabel}>{label}</Text><View style={[styles.skeletonLine, { width: label === t.id ? "75%" : "48%" }]} />
      </View>)}
      <View style={styles.editActions}><View style={styles.skeletonAction} /><View style={styles.skeletonAction} /></View>
      {error ? <View style={{ marginTop: 14 }}>
        <Text style={styles.cardDetail}>{display ? t.updateError : t.loadError}</Text>
        <Button variant="ghost" onPress={() => setRevision(value => value + 1)}>{t.retry}</Button>
      </View> : null}
    </View>
    <View style={[styles.primaryAction, { backgroundColor: nativeTokens.material.grouped }]} />
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{siteCopy.billing}</Text>
      <View style={[styles.skeletonLine, { width: "72%", marginTop: 18 }]} />
      <View style={[styles.skeletonLine, { width: "48%", marginTop: 10 }]} />
    </View>
    <MobileSettingsInline region={region} />
    {error ? <Button style={styles.signOut} variant="ghost" isDisabled={signingOut} onPress={confirmSignOut}>
      <Button.Label style={styles.signOutLabel}>{t.signOut}</Button.Label>
    </Button> : null}
    {signOutError ? <Text style={styles.inlineError} accessibilityRole="alert">{t.signOutError}</Text> : null}
  </ScrollView>;

  return <><ScrollView style={{ flex: 1, backgroundColor: nativeTokens.material.canvas }} contentContainerStyle={styles.content} accessibilityState={{ busy: refreshing }}>
    <Text style={styles.caption}>{t.caption}</Text>
    <Text style={styles.title}>{t.title}</Text>
    <View style={styles.identity}>
      <AccountAvatar url={model.avatarUrl} name={model.displayName} cacheKey={`${model.avatarUrl ?? model.id}:${avatarGeneration}`} />
      <View style={styles.identityName}>
        <Text style={styles.name}>{model.displayName}</Text>
        {currentVerified && (model.namePending || model.avatarPending) ? <Text style={styles.pending}>{t.pending}</Text> : null}
        <Button style={styles.avatarEdit} variant="ghost" size="sm" isDisabled={avatarBusy} onPress={error ? () => setRevision(value => value + 1) : () => void changeAvatar()}>
          {error ? t.retry : avatarBusy ? <ActivityIndicator /> : t.editAvatar}
        </Button>
      </View>
    </View>
    {avatarError ? <Text style={styles.inlineError} accessibilityRole="alert">{avatarError}</Text> : null}
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{t.profile}</Text>
      <AccountRow label={t.email} value={model.email ?? t.empty} />
      <AccountRow label={t.phone} value={model.phone ?? t.empty} />
      <View style={styles.row}>
        <Text style={styles.rowLabel}>{t.id}</Text>
        <View style={styles.idValue}>
          <Text style={[styles.rowValue, styles.idText]} numberOfLines={1} selectable>{model.id}</Text>
          <Button variant="ghost" size="sm" onPress={() => void copyId(model.id)} accessibilityLabel={copied ? t.copied : t.copy}>
            {copied ? t.copied : t.copy}
          </Button>
        </View>
        {copyError ? <Text style={styles.inlineError} accessibilityRole="alert">{t.copyError}</Text> : null}
      </View>
      {model.verification !== "not-applicable" ? <AccountRow label={t.verification} value={currentVerified ? t[model.verification] : t.checking} /> : null}
      <View style={styles.editActions}>
        <Button style={styles.editAction} variant="secondary" onPress={() => setEditor("nickname")}>{t.editName}</Button>
        {region === "cn" && phoneProofEnabled ? <Button style={styles.editAction} variant="secondary" isDisabled={!currentVerified} onPress={model.verification === "verified" ? () => setEditor("phone") : onOpenRealname}>
          {model.phone ? t.editPhone : t.bindPhone}
        </Button> : null}
      </View>
      {region === "cn" ? <Button style={styles.action} variant="ghost" isDisabled={!currentVerified} onPress={onOpenRealname}>
        {model.verification === "verified" ? t.manageIdentity : t.verifyIdentity}
      </Button> : null}
    </View>
    <Button style={styles.primaryAction} onPress={onOpenDetails} accessibilityLabel={t.details}><Button.Label style={styles.actionLabel}>{t.details}</Button.Label></Button>
    {referral.status !== "disabled" ? <View style={styles.card}>
      <Text style={styles.cardTitle}>{t.invite}</Text>
      <Text style={styles.cardDetail}>{t.inviteDetail}</Text>
      {referral.status === "ready" ? <>
        <View style={styles.stats}>
          <View style={styles.stat}><Text style={styles.rowLabel}>{t.successful}</Text><Text style={styles.statValue}>{referral.stats.successfulReferrals}</Text></View>
          <View style={styles.stat}><Text style={styles.rowLabel}>{t.granted}</Text><Text style={styles.statValue}>{referral.stats.grantedCredits}</Text></View>
          <View style={styles.stat}><Text style={styles.rowLabel}>{t.pendingRewards}</Text><Text style={styles.statValue}>{referral.stats.pendingRewards}</Text></View>
        </View>
        <Button style={styles.action} variant="secondary" onPress={() => { void Share.share({ message: referral.overview.url }); }} accessibilityLabel={t.share}>{t.share}</Button>
      </> : referral.status === "loading" ? <ActivityIndicator style={{ marginVertical: 20 }} /> : <>
        <Text style={styles.cardDetail}>{t.inviteError}</Text>
        <Button variant="ghost" onPress={() => setRevision(value => value + 1)}>{t.retry}</Button>
      </>}
    </View> : null}
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{siteCopy.billing}</Text>
      <Text style={styles.cardDetail}>{siteCopy.subscriptionManagementDescription}</Text>
      <Button style={styles.action} variant="secondary" onPress={onOpenBilling} accessibilityLabel={siteCopy.subscriptionManagement}>
        {siteCopy.subscriptionManagement}
      </Button>
    </View>
    <MobileSettingsInline region={region} />
    <Button style={styles.signOut} variant="ghost" isDisabled={signingOut} onPress={confirmSignOut} accessibilityLabel={t.signOut}>
      <Button.Label style={styles.signOutLabel}>{signingOut ? "…" : t.signOut}</Button.Label>
    </Button>
    {signOutError ? <Text style={styles.inlineError} accessibilityRole="alert">{t.signOutError}</Text> : null}
  </ScrollView>
    {editor ? <MobileAccountEditor key={editor} editor={editor} currentName={model.displayName} currentPhone={model.phone} region={region} language={language} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); void mobileAccountQueryClient.invalidateQueries({ queryKey: ["account", "profile"] }); setRevision(value => value + 1); }} /> : null}
  </>;
}
