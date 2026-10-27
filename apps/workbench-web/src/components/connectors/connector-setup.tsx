import { CheckIcon as Check } from "@opencraft/design-system-web/action-icons";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRightIcon as ArrowUpRight } from "@opencraft/design-system-web/action-icons";
import type { ConnectorDefinition, ConnectorInstance, ConnectorOAuthProgress, ConnectorProbe } from "@opencraft/connector-core";
import { connectorErrorMessage, type ConnectorOperation, type ManagedConnectorController } from "@opencraft/workbench-runtime";
import { SettingsActions, SettingsGroup, SettingsNotice, SettingsRow, SettingsTextInput } from "@opencraft/extension-react";
import { Button } from "../ui/button";
import { ConnectorIcon } from "./connector-icon";
import { connectorCheckLabel, connectorCredentialHelp, connectorOAuthStatus } from "./connector-setup-copy";

export function ConnectorSetup({ definition, instance, hostId, controller, supported, onDone }: {
  definition: ConnectorDefinition; instance: ConnectorInstance | null; hostId: string;
  controller: ManagedConnectorController; supported: boolean; onDone(): void;
}) {
  const prefix = useId(), [id] = useState(() => instance?.id ?? crypto.randomUUID());
  const [saved, setSaved] = useState(instance), [title, setTitle] = useState(instance?.title ?? definition.name);
  const [values, setValues] = useState<Record<string, string>>({ ...instance?.values }), [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<ConnectorOperation | null>(null);
  const [error, setError] = useState<{ operation: ConnectorOperation; message: string } | null>(null);
  const [probe, setProbe] = useState<ConnectorProbe | null>(null);
  const [pollUnavailable, setPollUnavailable] = useState(false);
  const [oauth, setOAuth] = useState<ConnectorOAuthProgress | null>(null), alive = useRef(true), flight = useRef<string | null>(null);
  const dirty = !saved || title !== saved.title || JSON.stringify(values) !== JSON.stringify(saved.values) || Object.keys(secrets).length > 0;
  const identityChanged = !!saved && JSON.stringify(values) !== JSON.stringify(saved.values);
  const incomplete = !title.trim() || definition.fields.some(field => field.required && !(field.secret
    ? secrets[field.key]?.trim() || (!identityChanged && saved?.configuredFields.includes(field.key))
    : values[field.key]?.trim()));
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (flight.current) void controller.cancelOAuth(hostId, flight.current).catch(() => undefined); }; }, [controller, hostId]);
  useEffect(() => {
    if (oauth?.status !== "pending") return;
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return; polling = true;
      void controller.oauthStatus(hostId, oauth.id).then(async progress => {
        if (!alive.current) return;
        setPollUnavailable(false);
        if (progress.status !== "pending") {
          setError(previous => previous?.operation === "cancelAuthorization" ? null : previous);
          flight.current = null; setOAuth(progress); await controller.load(hostId);
          if (alive.current) setSaved(controller.snapshot(hostId).data?.instances.find(row => row.id === id) ?? null);
        }
      }).catch(() => { if (alive.current) setPollUnavailable(true); }).finally(() => { polling = false; });
    }, 1500);
    return () => clearInterval(timer);
  }, [controller, hostId, id, oauth]);
  const action = async (operation: ConnectorOperation, work: (setStage: (operation: ConnectorOperation) => void) => Promise<void>) => {
    if (busy) return;
    let stage = operation;
    setBusy(stage); setError(null);
    try { await work(next => { stage = next; if (alive.current) setBusy(next); }); }
    catch (error) { if (alive.current) setError({ operation: stage, message: connectorErrorMessage(stage, error) }); }
    finally { if (alive.current) setBusy(null); }
  };
  const save = async () => {
    const row = await controller.save(hostId, { id, definitionId: definition.id, title, expectedRevision: saved?.revision ?? 0, values, secrets });
    if (alive.current) { setSaved(row); setSecrets({}); setProbe(null); } return row;
  };
  const disabled = !supported || busy !== null || oauth?.status === "pending";
  return <section className="connector-setup" aria-label={`${definition.name}接入配置`}>
    <header className="connector-setup__header">
      <ConnectorIcon id={definition.id} />
      <div><span className="connector-setup__eyebrow">{definition.category}</span><h2>{definition.name}</h2></div>
      <p>{definition.description}</p>
    </header>
    <div className="connector-setup__body">
      <section className="connector-setup__section" aria-label="接入准备">
        <h3>{definition.auth === "oauth" ? "连接你的账号" : "接入准备"}</h3>
        {definition.steps.map(step => <p key={step}>{step}</p>)}
        <SettingsActions align="start"><Button variant="secondary" size="sm" onClick={() => window.open(definition.guideUrl, "_blank", "noopener,noreferrer")}>查看接入说明 <ArrowUpRight size={14} aria-hidden="true" /></Button></SettingsActions>
      </section>
      {!supported ? <SettingsNotice>所选设备暂不支持此服务。你可以先查看接入说明。</SettingsNotice> : <section className="connector-setup__section" aria-label="连接信息">
      <h3>连接信息</h3>
      <SettingsGroup appearance="plain">
      <SettingsRow label="连接名称" htmlFor={`${prefix}-name`} layout="stacked"><SettingsTextInput id={`${prefix}-name`} value={title} maxLength={120} disabled={disabled} onChange={e => setTitle(e.target.value)} /></SettingsRow>
      {definition.fields.map(field => <SettingsRow key={field.key} label={field.label} htmlFor={`${prefix}-${field.key}`} layout="stacked"
        description={field.secret && saved?.configuredFields.includes(field.key) ? <span id={`${prefix}-${field.key}-help`}>{connectorCredentialHelp(definition, field, saved, values)}</span> : undefined}>
        <SettingsTextInput id={`${prefix}-${field.key}`} type={field.secret ? "password" : "text"} autoComplete="off" spellCheck={false}
          aria-describedby={field.secret && saved?.configuredFields.includes(field.key) ? `${prefix}-${field.key}-help` : undefined}
          required={field.required && !(field.secret && saved?.configuredFields.includes(field.key) && !identityChanged)} disabled={disabled}
          placeholder={field.placeholder ?? (field.secret && saved?.configuredFields.includes(field.key) ? "已保存" : undefined)}
          value={(field.secret ? secrets : values)[field.key] ?? ""} onChange={e => {
            const value = e.target.value;
            if (field.secret) setSecrets(previous => { const next = { ...previous }; if (value) next[field.key] = value; else delete next[field.key]; return next; });
            else setValues(previous => ({ ...previous, [field.key]: value }));
            setProbe(null);
          }} />
      </SettingsRow>)}
      </SettingsGroup>
      <p className="connector-setup__privacy">凭据仅保存在所选设备，不会写入聊天或技能。</p>
      </section>}
      {error ? <SettingsNotice tone="error">{error.message}
        {error.operation === "save" ? <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void action("load", async () => {
          await controller.load(hostId);
          if (!alive.current) return;
          const latest = controller.snapshot(hostId);
          if (latest.phase === "ready") onDone();
          else setError({ operation: "load", message: latest.error ?? connectorErrorMessage("load", null) });
        })}>查看已配置</Button> : null}
      </SettingsNotice> : null}
      {probe ? <section className="connector-setup__result" aria-label="检测结果">
        <div role="status"><strong><Check size={15} aria-hidden="true" /> {probe.level === "format" ? "配置格式正确" : "连接测试通过"}</strong>
          <p>{probe.level === "format" ? "仅检查了填写格式，尚未验证访问权限。" : `已读取 ${probe.toolCount} 个工具。`}</p>
        </div>
        <details><summary className="ui-native-disclosure">查看工具（{probe.toolCount}）</summary><ul>{probe.tools.map(tool => <li key={tool.name}><span>{tool.description}</span><small>{tool.readOnly ? "读取" : "逐次确认"}</small></li>)}</ul></details>
      </section> : null}
    {oauth ? <SettingsNotice role="status">{pollUnavailable && oauth.status === "pending" ? "暂时无法获取授权结果，正在继续检查。你也可以取消等待。" : connectorOAuthStatus(oauth.status)}
      {oauth.status === "pending" && oauth.authorizationUrl ? <SettingsActions align="start"><Button variant="primary" onClick={() => window.open(oauth.authorizationUrl!, "_blank", "noopener,noreferrer")}>打开授权页</Button><Button variant="secondary" onClick={() => void action("cancelAuthorization", async () => { await controller.cancelOAuth(hostId, oauth.id); flight.current = null; if (alive.current) setOAuth({ id: oauth.id, status: "cancelled" }); })}>取消等待</Button></SettingsActions> : null}
    </SettingsNotice> : null}
    </div>
    {supported ? <footer className="connector-setup__footer">
      <span role="status" className="connector-setup__save-state">{incomplete ? "请填写必填信息" : dirty ? "有未保存的修改" : <><Check size={14} aria-hidden="true" /> 配置已保存</>}</span>
      <SettingsActions>
        {definition.auth === "oauth" ? <Button variant="secondary" disabled={disabled || incomplete} loading={busy === "authorize"} onClick={() => void action("authorize", async setStage => {
          if (dirty) setStage("save");
          const row = dirty ? await save() : saved!; if (!alive.current) return;
          setStage("authorize"); setPollUnavailable(false);
          const progress = await controller.startOAuth(hostId, row.id);
          if (!alive.current) { await controller.cancelOAuth(hostId, progress.id); return; }
          flight.current = progress.id; setOAuth(progress);
        })}>登录授权</Button> : null}
        <Button variant="secondary" disabled={disabled || dirty || !saved} loading={busy === "check" || busy === "test"} onClick={() => void action(definition.adapter === "api" ? "check" : "test", async () => { const value = await controller.probe(hostId, id); if (alive.current) setProbe(value); })}>{connectorCheckLabel(definition)}</Button>
        {dirty ? <Button variant="primary" disabled={disabled || incomplete} loading={busy === "save"} onClick={() => void action("save", async () => { await save(); })}>保存</Button>
          : <Button variant="primary" disabled={disabled} onClick={onDone}>完成</Button>}
      </SettingsActions>
    </footer> : null}
  </section>;
}
