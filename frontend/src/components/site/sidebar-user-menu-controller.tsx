import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSession } from "@/contexts/session-context";
import { useOpenClaw } from "@/contexts/agent-context";
import { useRepositories } from "@/contexts/repository-context";
import { usePaidBillingEnabled } from "@/contexts/runtime-config-context";
import { useT } from "@/i18n/t";
import { AGENT_SECTION_PATH_BY_ID, getAgentSectionHref, shouldShowWorkbenchEntry } from "@/lib/agent-routes";
import { useAppNavigate, useAppSearchParams } from "@/lib/app-navigation";
import { shouldMoveModelEntryToAccountMenu } from "@/lib/agent-plan-navigation";
import { avatarImageUrl } from "@/lib/avatar-image";
import { accountPassCanRenew, accountPassDisplayName } from "@/lib/account-pass-summary";
import { getPassStatus, isPaidBillingEnabled } from "@/lib/billing-flow";
import { publicSiteHref } from "@/lib/public-site-navigation";
import { resolveVisiblePublicSiteLocale } from "@/lib/public-site-routing";
import { isGlobal } from "@/lib/region";
import { useAccountPassSummary } from "@/lib/use-account-pass-summary";
import { usePassUpgrade } from "@/lib/use-pass-upgrade";
import { installConsoleShowCommand, isConsoleShowEnabled, subscribeConsoleShow } from "@/lib/console-show-event";
import { resolveAgentConsoleCollectionLabel } from "@/pages/marketing/agent-provider-locale";
import { PRODUCT_FEEDBACK_URL } from "@/constants/product-feedback";
import { InternationalLanguageMenu } from "./language-switcher";
import { SidebarUserMenu, type SidebarUserMenuProps } from "./sidebar-user-menu";

export function SidebarUserMenuController({ showLanguageSwitcher = false }: { showLanguageSwitcher?: boolean }) {
  const { session, signOut } = useSession();
  const { activePass, modifyingPass, passUpgradeFailed, passesLoading, passesError } = useOpenClaw();
  const { plans } = useRepositories();
  const paidBillingActive = isPaidBillingEnabled(usePaidBillingEnabled());
  const t = useT();
  const { i18n } = useTranslation();
  const navigate = useAppNavigate();
  const [searchParams] = useAppSearchParams();
  const languageId = useId();
  const [open, setOpen] = useState(false);
  const [loadedUserId, setLoadedUserId] = useState<string>();
  const userId = session.user?.id;
  // 首次展开才读账务；同一账号关闭后保留摘要，换号关闭态不额外发请求。
  const enabled = open || Boolean(userId && loadedUserId === userId);
  const summary = useAccountPassSummary({ userId, activePass, modifyingPass, paidBillingActive, global: isGlobal, enabled, listMyPasses: plans.listMyPasses });
  const operablePass = summary.pass;
  const upgrade = usePassUpgrade({ userId, passId: operablePass?.pass_id, currentPass: operablePass, enabled: enabled && paidBillingActive });
  const canRenew = accountPassCanRenew(operablePass, isGlobal, paidBillingActive);
  const subscribeHref = publicSiteHref("/subscribe", resolveVisiblePublicSiteLocale(null, i18n.language), { localized: isGlobal });
  const [hiddenEntriesRevealed, setHiddenEntriesRevealed] = useState(() => isConsoleShowEnabled());
  const [hostname, setHostname] = useState<string | null>(null);
  useEffect(() => { setHostname(window.location.hostname); }, []);
  useEffect(() => subscribeConsoleShow(setHiddenEntriesRevealed), []);
  useEffect(() => installConsoleShowCommand(), []);

  const state = summary.pass ? "ready" : passesLoading || summary.state === "loading" ? "loading" : passesError || summary.state === "error" ? "error" : summary.state;
  const stateLabel = state === "loading" ? t("加载中...") : state === "error" ? t("套餐列表加载失败") : t("未订阅");
  const subscriptionName = accountPassDisplayName(operablePass, session.currentSubscription?.code, "");
  const planLabel = operablePass || subscriptionName ? `${t("套餐")}：${subscriptionName}` : stateLabel;
  const creditLabel = subscriptionName && (state === "none" || state === "idle")
    ? `${t("已使用积分")}：${t("暂无法确认")}` : stateLabel;
  const status = operablePass ? getPassStatus(operablePass) : null;
  const statusText: SidebarUserMenuProps["status"] = operablePass?.status === "modifying"
    ? { text: passUpgradeFailed ? t("套餐升级失败") : t("套餐升级中"), tone: "warning" }
    : status === "expired" ? { text: t("已过期"), tone: "danger" }
    : status === "isolated" ? { text: t("套餐已隔离，请前往续费。"), tone: "warning" } : undefined;
  const credit: SidebarUserMenuProps["credit"] = summary.credits
    ? { state: "ready", label: t("已使用积分"), ...summary.credits }
    : { state: state === "ready" ? "idle" : state, label: creditLabel };
  const entries: SidebarUserMenuProps["entries"][number][] = [
    { id: "account", kind: "account", href: "/account", label: t("账号") },
    { id: "billing", kind: "account", href: "/account/billing", label: t("套餐与费用") },
  ];
  if (shouldMoveModelEntryToAccountMenu(activePass)) entries.push({
    id: "model",
    kind: "model",
    href: getAgentSectionHref(AGENT_SECTION_PATH_BY_ID.model, searchParams),
    label: resolveAgentConsoleCollectionLabel("model", i18n.language, t),
  });
  if (shouldShowWorkbenchEntry({ hostname, revealed: hiddenEntriesRevealed })) entries.push({ id: "workbench", kind: "workbench", href: AGENT_SECTION_PATH_BY_ID.workbench, label: t("工作台") });
  if (!isGlobal) entries.push({ id: "feedback", kind: "feedback", href: PRODUCT_FEEDBACK_URL, label: t("产品反馈"), external: true });
  return <SidebarUserMenu open={open} onOpenChange={(next) => { if (next) setLoadedUserId(userId); setOpen(next); }}
    name={session.user?.name || t("用户")} email={session.user?.email || undefined} avatarSrc={avatarImageUrl(session.user?.avatarUrl ?? null)}
    planLabel={planLabel} credit={credit} status={statusText} entries={entries}
    upgrade={canRenew && upgrade.pass && upgrade.pass.pass_id === operablePass?.pass_id && upgrade.options.length > 0 ? { href: `${subscribeHref}/?upgrade_pass_id=${encodeURIComponent(upgrade.pass.pass_id)}`, label: t("升级套餐") } : undefined}
    labels={{ trigger: t("打开用户菜单"), menu: t("账号管理"), logout: t("退出登录"), language: t("语言") }}
    languageContent={isGlobal && showLanguageSwitcher ? <InternationalLanguageMenu id={languageId} ariaLabel={t("语言")} reloadAfterSwitch /> : undefined}
    onSignOut={() => { navigate("/", { replace: true }); void signOut(); }} />;
}
