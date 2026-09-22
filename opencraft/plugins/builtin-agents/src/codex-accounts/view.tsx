import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import {
  SettingsButton,
  SettingsCopyButton,
  SettingsGroup,
  SettingsIconButton,
  SettingsNotice,
  SettingsPanel,
  SettingsSection,
  type ExtensionSettingsViewProps,
} from "@opencraft/extension-react";
import type { CodexAccountView, CodexDeviceLoginView } from "@opencraft/appserver-protocol";

import type { CodexAccountsService } from "./service.js";

function accountStatusLabel(status: CodexAccountView["status"]): string {
  switch (status) {
    case "disabled": return "已停用";
    case "ready": return "可用";
    case "held": return "暂时受限";
    case "exhausted": return "额度已耗尽";
    case "error": return "认证异常";
  }
}

function planLabel(account: CodexAccountView): string {
  const multiplier = account.rateLimitTier?.match(/max_(\d+)x/u)?.[1];
  if (multiplier) return `Max (${multiplier}x)`;
  const plan = account.subscriptionType;
  return plan ? `${plan[0]?.toUpperCase() ?? ""}${plan.slice(1)}` : "ChatGPT OAuth";
}

function windowLabel(minutes: number | null, slot: "primary" | "secondary"): string {
  if (minutes === 300) return "5H";
  if (minutes === 10_080) return "7D";
  if (minutes !== null && minutes % 1_440 === 0) return `${minutes / 1_440}D`;
  if (minutes !== null && minutes % 60 === 0) return `${minutes / 60}H`;
  return slot === "primary" ? "主要" : "次要";
}

function formatDate(value: number | null): string {
  if (value === null) return "—";
  return new Date(value).toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relativeDate(value: number | null): string {
  if (value === null) return "尚未使用";
  const elapsed = Math.max(0, Date.now() - value);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚使用";
  if (minutes < 60) return `${minutes} 分钟前使用`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前使用`;
  return `${Math.floor(hours / 24)} 天前使用`;
}

function QuotaSlot({ window }: { readonly window: CodexAccountView["limitWindows"][number] }) {
  const percentage = window.utilization === null ? null : Math.round(window.utilization * 100);
  const tone = percentage === null ? "unknown" : percentage >= 90 ? "danger" : percentage >= 75 ? "warning" : "neutral";
  return <span className="codex-account__quota" data-tone={tone} title={window.resetAt === null ? undefined : `${formatDate(window.resetAt)} 重置`}>
    <small>{windowLabel(window.windowMinutes, window.slot)}</small>
    <strong>{percentage === null ? "—" : `${percentage}%`}</strong>
  </span>;
}

function AccountActionsMenu({ account, index, total, pending, onMove, onRefresh, onToggle, onRemove }: {
  readonly account: CodexAccountView;
  readonly index: number;
  readonly total: number;
  readonly pending: boolean;
  readonly onMove: (offset: number) => void;
  readonly onRefresh: () => void;
  readonly onToggle: () => void;
  readonly onRemove: () => void;
}) {
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <SettingsIconButton className="codex-account__menu-trigger" label={`${account.label} 的操作`} disabled={pending}>
        <MoreHorizontal size={16} />
      </SettingsIconButton>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="codex-account-menu" align="end" sideOffset={5} collisionPadding={12}>
        <DropdownMenu.Item className="codex-account-menu__item" disabled={pending} onSelect={onToggle}>
          {account.enabled ? <X size={15} /> : <Check size={15} />}
          {account.enabled ? "停用账户" : "启用账户"}
        </DropdownMenu.Item>
        <DropdownMenu.Item className="codex-account-menu__item" disabled={pending || index === 0} onSelect={() => onMove(-1)}>
          <ArrowUp size={15} />上移
        </DropdownMenu.Item>
        <DropdownMenu.Item className="codex-account-menu__item" disabled={pending || index === total - 1} onSelect={() => onMove(1)}>
          <ArrowDown size={15} />下移
        </DropdownMenu.Item>
        <DropdownMenu.Item className="codex-account-menu__item" disabled={pending || !account.enabled} onSelect={onRefresh}>
          <RefreshCw size={15} />刷新用量
        </DropdownMenu.Item>
        <DropdownMenu.Separator className="codex-account-menu__separator" />
        <DropdownMenu.Item className="codex-account-menu__item codex-account-menu__item--danger" disabled={pending} onSelect={onRemove}>
          <Trash2 size={15} />移除账户
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

function AccountRow({ account, index, total, service }: {
  readonly account: CodexAccountView;
  readonly index: number;
  readonly total: number;
  readonly service: CodexAccountsService;
}) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const run = (key: string, action: () => Promise<void>) => {
    setPending(key);
    setError(null);
    void action()
      .catch(cause => setError(cause instanceof Error ? cause.message : "操作失败"))
      .finally(() => setPending(null));
  };
  const move = (offset: number) => {
    const accounts = service.getSnapshot().accounts;
    const order = accounts.map(entry => entry.id);
    const next = index + offset;
    if (next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next]!, order[index]!];
    run("order", () => service.reorder(order));
  };
  return <>
    <article className="codex-account" data-enabled={account.enabled} data-status={account.status} aria-busy={pending !== null}>
      <div className="codex-account__row">
        <button className="codex-account__disclosure" type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>
          <span className="codex-account__status-dot" aria-hidden="true" />
          <span className="codex-account__identity">
            <span className="codex-account__name-line">
              <strong>{account.label}</strong>
              <span className="codex-account__plan">{planLabel(account)}</span>
            </span>
            <span className="codex-account__status-copy">
              {account.credentialConfigured ? accountStatusLabel(account.status) : "凭据不可用"}
              <span aria-hidden="true">·</span>
              {relativeDate(account.lastUsedAt)}
              {pending === "refresh" ? <><span aria-hidden="true">·</span>正在刷新…</> : null}
            </span>
          </span>
          <span className="codex-account__quotas" aria-label="额度使用情况">
            {account.limitWindows.length === 0 ? <span className="codex-account__quota" data-tone="unknown"><small>额度</small><strong>—</strong></span>
              : account.limitWindows.map(window => <QuotaSlot key={window.slot} window={window} />)}
          </span>
          <ChevronRight className="codex-account__chevron" size={16} aria-hidden="true" />
        </button>
        <AccountActionsMenu
          account={account}
          index={index}
          total={total}
          pending={pending !== null}
          onMove={move}
          onRefresh={() => run("refresh", () => service.refreshAccount(account.id))}
          onToggle={() => run("enabled", () => service.setEnabled(account.id, !account.enabled))}
          onRemove={() => setConfirming(true)}
        />
      </div>
      {error ? <div className="codex-account__error" role="alert">{error}</div> : null}
      {expanded ? <div className="codex-account__details" id={detailsId}>
        <dl>
          <div><dt>登录身份</dt><dd>{account.email ?? account.label}</dd></div>
          <div><dt>使用顺序</dt><dd>第 {index + 1} 位</dd></div>
          <div><dt>最近同步</dt><dd>{formatDate(account.observedAt)}</dd></div>
          <div><dt>最近使用环境</dt><dd>{account.lastUsedHostId ?? "—"}</dd></div>
          {account.heldUntil === null ? null : <div><dt>限制解除</dt><dd>{formatDate(account.heldUntil)}</dd></div>}
        </dl>
      </div> : null}
    </article>
    <AlertDialog.Root open={confirming} onOpenChange={setConfirming}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="codex-account-dialog__overlay" />
        <AlertDialog.Content className="codex-account-dialog codex-account-dialog--compact">
          <AlertDialog.Title>移除 Codex 账户？</AlertDialog.Title>
          <AlertDialog.Description>将删除“{account.label}”的本机 OAuth 凭据和账户池绑定。现有会话记录不会删除。</AlertDialog.Description>
          <footer>
            <AlertDialog.Cancel asChild><SettingsButton disabled={pending !== null}>取消</SettingsButton></AlertDialog.Cancel>
            <SettingsButton variant="danger" disabled={pending !== null} onClick={() => run("remove", () => service.remove(account.id))}>确认移除</SettingsButton>
          </footer>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  </>;
}

function AddAccountMenu({ disabled, starting, importing, onSignIn, onImport }: {
  readonly disabled: boolean;
  readonly starting: boolean;
  readonly importing: boolean;
  readonly onSignIn: () => void;
  readonly onImport: () => void;
}) {
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <SettingsButton disabled={disabled}>
        <Plus size={14} aria-hidden="true" />添加账户<ChevronDown size={14} aria-hidden="true" />
      </SettingsButton>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="codex-account-menu codex-account-menu--add" align="end" sideOffset={5} collisionPadding={12}>
        <DropdownMenu.Item className="codex-account-menu__item codex-account-menu__item--descriptive" disabled={disabled} onSelect={onSignIn}>
          <UserRound size={16} />
          <span><strong>{starting ? "正在启动登录…" : "在浏览器中登录"}</strong><small>使用 ChatGPT 设备码添加账户</small></span>
        </DropdownMenu.Item>
        <DropdownMenu.Item className="codex-account-menu__item codex-account-menu__item--descriptive" disabled={disabled} onSelect={onImport}>
          <Download size={16} />
          <span><strong>{importing ? "正在导入…" : "导入本机 Codex 登录"}</strong><small>复制此设备已有的 Codex 登录</small></span>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

export function CodexDeviceLoginContent({ login, canceling, onCancel }: {
  readonly login: CodexDeviceLoginView;
  readonly canceling: boolean;
  readonly onCancel: () => void;
}) {
  return <>
    <header className="codex-account-dialog__header">
      <span className="codex-account-dialog__icon" aria-hidden="true"><UserRound size={18} /></span>
      <div><Dialog.Title>登录 ChatGPT</Dialog.Title><Dialog.Description>在系统浏览器中完成授权，OpenCraft 会自动接收结果。</Dialog.Description></div>
      <Dialog.Close asChild><SettingsIconButton label="关闭登录" disabled={canceling}><X size={17} /></SettingsIconButton></Dialog.Close>
    </header>
    <div className="codex-device-login">
      <span className="codex-device-login__eyebrow">设备验证码</span>
      <div className="codex-device-login__code"><strong>{login.userCode}</strong><SettingsCopyButton value={login.userCode} label="复制" /></div>
      <p>验证码将在 {formatDate(login.expiresAt)} 失效。</p>
      <div className="codex-device-login__waiting" role="status"><span aria-hidden="true" />正在等待浏览器授权…</div>
    </div>
    <footer>
      <SettingsButton variant="quiet" disabled={canceling} onClick={onCancel}>{canceling ? "正在取消…" : "取消"}</SettingsButton>
      <SettingsButton variant="primary" onClick={() => window.open(login.verificationUrl, "_blank", "noopener,noreferrer")}>
        <ExternalLink size={14} />打开验证页面
      </SettingsButton>
    </footer>
  </>;
}

function DeviceLoginDialog({ login, service }: { readonly login: CodexDeviceLoginView | null; readonly service: CodexAccountsService }) {
  const [canceling, setCanceling] = useState(false);
  const cancel = () => {
    if (canceling) return;
    setCanceling(true);
    void service.cancelDeviceLogin().catch(() => undefined).finally(() => setCanceling(false));
  };
  return <Dialog.Root open={login !== null} onOpenChange={open => { if (!open && login !== null) cancel(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="codex-account-dialog__overlay" />
      {login === null ? null : <Dialog.Content className="codex-account-dialog" onEscapeKeyDown={event => { if (canceling) event.preventDefault(); }}>
        <CodexDeviceLoginContent login={login} canceling={canceling} onCancel={cancel} />
      </Dialog.Content>}
    </Dialog.Portal>
  </Dialog.Root>;
}

export function createCodexAccountsView(service: CodexAccountsService) {
  return function CodexAccountsView(_props: ExtensionSettingsViewProps) {
    const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
    const [starting, setStarting] = useState(false);
    const [importing, setImporting] = useState(false);
    useEffect(() => { void service.refresh(); }, []);
    useEffect(() => {
      if (snapshot.login === null) return;
      const timer = setInterval(() => { void service.pollDeviceLogin().catch(() => undefined); }, 1_500);
      return () => clearInterval(timer);
    }, [snapshot.login?.sessionId]);
    const start = () => {
      setStarting(true);
      void service.startDeviceLogin().catch(() => undefined).finally(() => setStarting(false));
    };
    const importLocal = () => {
      setImporting(true);
      void service.importLocalLogin().catch(() => undefined).finally(() => setImporting(false));
    };
    const busy = starting || importing || snapshot.login !== null;
    return <SettingsPanel
      title="Codex 账户"
      actions={<SettingsIconButton label="刷新账户" disabled={snapshot.phase === "loading"} onClick={() => void service.refresh()}><RefreshCw size={16} /></SettingsIconButton>}
    >
      <div className="codex-accounts-page">
        {snapshot.error ? <SettingsNotice tone="error">{snapshot.error}</SettingsNotice> : null}
        <SettingsSection
          title="ChatGPT 账户"
          description="多个账户按顺序使用；已有会话在账户可用时保持绑定。"
          action={snapshot.accounts.length === 0 ? undefined : <AddAccountMenu disabled={busy} starting={starting} importing={importing} onSignIn={start} onImport={importLocal} />}
        >
          <SettingsGroup className="codex-account-list" aria-label="Codex 账户列表">
            {snapshot.phase === "loading" && snapshot.accounts.length === 0 ? <div className="codex-account-list__state" role="status"><RefreshCw size={16} />正在读取账户…</div> : null}
            {snapshot.phase !== "loading" && snapshot.accounts.length === 0 ? <div className="codex-account-list__empty">
              <span className="codex-account-list__empty-icon" aria-hidden="true"><UserRound size={18} /></span>
              <div><strong>还没有 Codex 账户</strong><p>添加 ChatGPT 账户后，Codex 会按可用额度自动选择并保持会话绑定。</p></div>
              <AddAccountMenu disabled={busy} starting={starting} importing={importing} onSignIn={start} onImport={importLocal} />
            </div> : null}
            {snapshot.accounts.map((account, index) => <AccountRow key={account.id} account={account} index={index} total={snapshot.accounts.length} service={service} />)}
          </SettingsGroup>
        </SettingsSection>
      </div>
      <DeviceLoginDialog login={snapshot.login} service={service} />
    </SettingsPanel>;
  };
}
