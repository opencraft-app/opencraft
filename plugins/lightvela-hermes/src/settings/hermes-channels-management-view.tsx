import { Loader2, MessageCircle, QrCode, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeCanvas } from "qrcode.react";

import {
  SettingsActions,
  SettingsButton,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsTextInput,
} from "@opencraft/extension-react";

import type { LightVelaAccountService } from "../account/lightvela-account-service";
import {
  configureHermesChannel,
  buildHermesQrUrlCommand,
  deleteHermesChannel,
  listHermesChannels,
  parseHermesQrStream,
  type HermesChannelKind,
  type HermesQrChannelKind,
} from "../management/channels/hermes-channel-client";
import { accountDebugCommandExecutor } from "../management/debug-command";

const CHANNELS: ReadonlyArray<{ value: HermesChannelKind; label: string; first: string; second?: string }> = [
  { value: "qqbot", label: "QQ Bot", first: "App ID", second: "Client Secret" },
  { value: "wecom", label: "WeCom", first: "App ID", second: "Client Secret" },
  { value: "yuanbao", label: "Yuanbao", first: "App Key", second: "App Secret" },
  { value: "telegram", label: "Telegram", first: "Bot Token" },
  { value: "discord", label: "Discord", first: "Bot Token" },
  { value: "slack", label: "Slack", first: "Bot Token", second: "App Token" },
  { value: "dingtalk", label: "DingTalk", first: "Client ID", second: "Client Secret" },
];

const QR_CHANNELS: ReadonlyArray<{ value: HermesQrChannelKind; label: string }> = [
  { value: "weixin", label: "WeChat" },
  { value: "feishu", label: "Feishu / Lark" },
  { value: "qqbot", label: "QQ Bot" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "yuanbao", label: "Yuanbao" },
  { value: "dingtalk", label: "DingTalk" },
];

type QrUiStatus = "init" | "loading" | "ready" | "expired" | "failed" | "success";

export function HermesChannelsManagementView({ account, botId }: {
  readonly account: LightVelaAccountService;
  readonly botId: string;
}) {
  const executor = accountDebugCommandExecutor(account);
  const [channel, setChannel] = useState<HermesChannelKind>("qqbot");
  const [primary, setPrimary] = useState("");
  const [secondary, setSecondary] = useState("");
  const [output, setOutput] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qrChannel, setQrChannel] = useState<HermesQrChannelKind>("weixin");
  const [qrUrl, setQrUrl] = useState("");
  const [qrStatus, setQrStatus] = useState<QrUiStatus>("init");
  const qrUrlRef = useRef("");
  const qrStatusRef = useRef<QrUiStatus>("init");
  const qrFlowIdRef = useRef(0);
  const selected = CHANNELS.find((item) => item.value === channel)!;

  const load = useCallback(async () => {
    setPending("load"); setError(null);
    try { setOutput(await listHermesChannels(executor, botId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  }, [account, botId]);
  useEffect(() => { void load(); }, [load]);

  const connect = async () => {
    setPending("connect"); setError(null);
    try {
      await configureHermesChannel(executor, botId, channel, primary.trim(), secondary.trim());
      setPrimary(""); setSecondary("");
      setOutput(await listHermesChannels(executor, botId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  };

  const remove = async () => {
    setPending("delete"); setError(null);
    try {
      await deleteHermesChannel(executor, botId, channel);
      setOutput(await listHermesChannels(executor, botId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(null); }
  };

  const updateQrStatus = (next: QrUiStatus) => {
    qrStatusRef.current = next;
    setQrStatus(next);
  };

  // Flow identity, latest-status ownership, and accumulated NDJSON parsing are
  // directly migrated from mono2's HermesQrCodeModal. The enclosing Settings
  // section is the Workbench-only presentation adapter.
  const startQrCodeFlow = async () => {
    qrFlowIdRef.current += 1;
    const currentFlowId = qrFlowIdRef.current;
    const isFlowValid = () => qrFlowIdRef.current === currentFlowId;
    qrUrlRef.current = "";
    setQrUrl("");
    updateQrStatus("loading");
    setError(null);
    let decoded = "";
    try {
      const result = await account.execDebugCommandStream(
        botId,
        buildHermesQrUrlCommand({
          platform: qrChannel,
          isI18n: account.getSnapshot().region === "intl",
          bindId: qrChannel === "yuanbao" ? botId : undefined,
        }),
        ({ chunk }) => {
          if (!isFlowValid()) return;
          decoded += chunk;
          const line = parseHermesQrStream(decoded);
          if (!line) return;
          if (line.status === "failed") {
            updateQrStatus("failed");
            return;
          }
          if (line.status === "success") {
            updateQrStatus("success");
            void load();
            return;
          }
          if (line.url && !qrUrlRef.current) {
            qrUrlRef.current = line.url;
            setQrUrl(line.url);
            updateQrStatus("ready");
          }
        },
        { timeoutMs: 180_000 },
      );
      if (!isFlowValid()) return;
      if ((result.status !== "SUCCESS" || result.exitCode !== 0) && qrStatusRef.current === "loading") {
        updateQrStatus("expired");
      }
    } catch (cause) {
      if (!isFlowValid()) return;
      updateQrStatus("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <>
      <SettingsSection title="Agent channels" icon={<MessageCircle size={16} />} description="Hermes remains the source of truth; mutations restart the gateway before the list is reread." action={<SettingsButton type="button" variant="ghost" disabled={pending !== null} onClick={() => void load()}><RefreshCw size={14} /> Refresh</SettingsButton>}>
        {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
        {pending === "load" && !output ? <SettingsNotice>Reading Hermes channels…</SettingsNotice> : null}
        {output ? <pre className="lightvela-management-output">{output}</pre> : null}
      </SettingsSection>
      <SettingsSection title="Connect by QR code" icon={<QrCode size={16} />} description="Uses mono2's acli NDJSON flow; a newer attempt invalidates all events from the previous flow.">
        <SettingsGroup>
          <SettingsRow label="Channel" htmlFor="hermes-qr-channel"><SettingsSelect id="hermes-qr-channel" value={qrChannel} disabled={qrStatus === "loading" || qrStatus === "ready"} onChange={(event) => { qrFlowIdRef.current += 1; setQrChannel(event.currentTarget.value as HermesQrChannelKind); qrUrlRef.current = ""; setQrUrl(""); updateQrStatus("init"); }}>{QR_CHANNELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</SettingsSelect></SettingsRow>
          {qrStatus === "loading" ? <SettingsNotice><Loader2 size={14} className="lightvela-management-spinner" /> Generating QR code…</SettingsNotice> : null}
          {qrStatus === "ready" && qrUrl ? <div className="lightvela-management-qr"><QRCodeCanvas value={qrUrl} size={200} level="L" /><span>Scan and confirm in {QR_CHANNELS.find((item) => item.value === qrChannel)?.label}.</span></div> : null}
          {qrStatus === "success" ? <SettingsNotice tone="success">Channel connected.</SettingsNotice> : null}
          {qrStatus === "expired" ? <SettingsNotice>The QR session expired. Start a new scan.</SettingsNotice> : null}
          {qrStatus === "failed" ? <SettingsNotice tone="error">Could not complete the QR flow.</SettingsNotice> : null}
        </SettingsGroup>
        <SettingsActions><SettingsButton type="button" variant="primary" disabled={qrStatus === "loading" || qrStatus === "ready"} onClick={() => void startQrCodeFlow()}>{qrStatus === "expired" || qrStatus === "failed" ? "Retry" : "Connect with QR code"}</SettingsButton>{qrStatus === "loading" || qrStatus === "ready" ? <SettingsButton type="button" onClick={() => { qrFlowIdRef.current += 1; qrUrlRef.current = ""; setQrUrl(""); updateQrStatus("init"); }}>Cancel</SettingsButton> : null}</SettingsActions>
      </SettingsSection>
      <SettingsSection title="Connect channel" description="Uses the same acli command factory contract as the LightVela console.">
        <SettingsGroup>
          <SettingsRow label="Channel" htmlFor="hermes-channel-kind"><SettingsSelect id="hermes-channel-kind" value={channel} onChange={(event) => { setChannel(event.currentTarget.value as HermesChannelKind); setPrimary(""); setSecondary(""); }}>{CHANNELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</SettingsSelect></SettingsRow>
          <SettingsRow label={selected.first} htmlFor="hermes-channel-primary"><SettingsTextInput id="hermes-channel-primary" type="password" autoComplete="off" value={primary} onChange={(event) => setPrimary(event.currentTarget.value)} /></SettingsRow>
          {selected.second ? <SettingsRow label={selected.second} htmlFor="hermes-channel-secondary"><SettingsTextInput id="hermes-channel-secondary" type="password" autoComplete="off" value={secondary} onChange={(event) => setSecondary(event.currentTarget.value)} /></SettingsRow> : null}
        </SettingsGroup>
        <SettingsActions align="between"><SettingsButton type="button" variant="danger" disabled={pending !== null} onClick={() => void remove()}><Trash2 size={14} /> Remove channel</SettingsButton><SettingsButton type="button" variant="primary" disabled={pending !== null || !primary.trim() || (!!selected.second && !secondary.trim())} onClick={() => void connect()}>{pending === "connect" ? "Connecting…" : "Connect"}</SettingsButton></SettingsActions>
      </SettingsSection>
    </>
  );
}
