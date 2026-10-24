import { serverFetch } from "../runtime/server-context";
import { useEffect, useRef, useState } from 'react';
import { useIntl } from '@opencraft/i18n/react';
import { SettingsActions, SettingsButton, SettingsGroup, SettingsNotice, SettingsPageHeader, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch, SettingsTextInput } from '@opencraft/extension-react';
import type { HubNetworkSnapshot, IdentityAuthority } from '@opencraft/hub-network';
import '../styles/hub-network-settings.scss';

interface Preview { hubId: string; name: string; endpoint: string; fingerprint: string; origins: string[]; allowTransit: boolean; authority: IdentityAuthority | null; }
type Draft = Pick<HubNetworkSnapshot, 'name' | 'endpoint' | 'origin' | 'accepting' | 'forwarding'>;
const endpoint = '/__opencraft_hub/settings';
export function HubNetworkSettings() {
  const intl = useIntl();
  const zh = intl.locale.toLowerCase().startsWith('zh');
  const copy = (cn: string, en: string) => zh ? cn : en;
  const [snapshot, setSnapshot] = useState<HubNetworkSnapshot | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState(''), [denied, setDenied] = useState(false), [pending, setPending] = useState(false);
  const [invitation, setInvitation] = useState(''), [preview, setPreview] = useState<Preview | null>(null), [trusted, setTrusted] = useState(false), [publishOrigin, setPublishOrigin] = useState('');
  const [origins, setOrigins] = useState(''), [transit, setTransit] = useState(false), [generated, setGenerated] = useState('');
  const alive = useRef(false), generation = useRef(0), latest = useRef<HubNetworkSnapshot | null>(null), busy = useRef(false);
  const accept = (next: HubNetworkSnapshot) => {
    if (!alive.current || (latest.current && next.revision < latest.current.revision)) return;
    latest.current = next; setSnapshot(next); setDraft(current => current ?? { name: next.name, endpoint: next.endpoint, origin: next.origin, accepting: next.accepting, forwarding: next.forwarding });
  };
  useEffect(() => {
    alive.current = true; const controller = new AbortController(); let loading = false;
    const read = async () => {
      if (loading || busy.current) return; loading = true; const epoch = generation.current;
      try {
        const res = await serverFetch(endpoint, { cache: 'no-store', signal: controller.signal });
        if (!alive.current || epoch !== generation.current) return;
        if (res.status === 401 || res.status === 403) { setDenied(true); latest.current = null; setSnapshot(null); setDraft(null); setGenerated(''); setInvitation(''); setPreview(null); return; }
        if (!res.ok) throw new Error('unavailable');
        const next = await res.json() as HubNetworkSnapshot;
        if (alive.current && epoch === generation.current) { accept(next); setDenied(false); setError(''); }
      } catch { if (alive.current && !controller.signal.aborted && epoch === generation.current) setError(copy('暂时无法读取 Hub 网络，已有配置仍保留。', 'Hub network is unavailable. Existing configuration is retained.')); }
      finally { loading = false; }
    };
    void read(); const timer = setInterval(() => { void read(); }, 3000);
    return () => { alive.current = false; generation.current++; controller.abort(); clearInterval(timer); };
  }, []);
  const action = async (name: string, input: Record<string, unknown> = {}) => {
    if (!latest.current || busy.current) return;
    busy.current = true; setPending(true); setError(''); const epoch = ++generation.current;
    try {
      const res = await serverFetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name, revision: latest.current.revision, ...input }) });
      const result = await res.json(); if (!alive.current || epoch !== generation.current) return;
      if (result.snapshot) accept(result.snapshot);
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) { setDenied(true); latest.current = null; setSnapshot(null); setDraft(null); setGenerated(''); setInvitation(''); setPreview(null); }
        throw new Error(res.status === 409 ? 'conflict' : 'change');
      }
      if (name === 'inspect') { setPreview(result.invitationPreview); setTrusted(false); setPublishOrigin(''); }
      if (name === 'connect') { setInvitation(''); setPreview(null); setTrusted(false); setDraft(current => current ? { ...current, origin: result.snapshot.origin } : current); }
      if (name === 'untrust') setDraft(current => current ? { ...current, origin: '' } : current);
      if (name === 'revoke') setGenerated('');
      if (result.invitation) setGenerated(result.invitation);
    } catch (e) {
      if (alive.current && epoch === generation.current) setError(e instanceof Error && e.message === 'conflict'
        ? copy('配置已被其他管理员更新，请核对后重试。', 'Another administrator changed the configuration. Review and retry.')
        : copy('未收到操作确认，请核对当前状态、邀请和权限后重试。', 'No confirmation received. Review the current state, invitation and permissions before retrying.'));
    } finally { busy.current = false; if (alive.current && epoch === generation.current) setPending(false); }
  };
  const actionLabel = (value: string) => ({
    configure: copy('更新节点配置', 'Update node configuration'), invite: copy('生成邀请', 'Create invitation'),
    connect: copy('连接节点', 'Connect node'), disconnect: copy('移除连接', 'Remove connection'),
    revoke: copy('撤销接入', 'Revoke enrollment'), untrust: copy('撤销登录来源信任', 'Revoke identity trust'),
    redeem_invitation: copy('节点已接入', 'Node enrolled'), configure_identity_authority: copy('配置登录来源', 'Configure identity source'),
  } as Record<string, string>)[value] ?? value;
  const title = copy('Hub 网络', 'Hub network');
  if (denied) return <><SettingsPageHeader title={title} /><SettingsNotice>{copy('需要当前服务器的管理员权限才能管理 Hub 网络。', 'Administrator permission on this server is required to manage the Hub network.')}</SettingsNotice></>;
  return <div className="hub-network-settings" aria-busy={pending}>
    <SettingsPageHeader title={title} description={copy('管理当前服务器的节点连接与中继。连接其他 Hub 与允许接入可以同时启用。', 'Manage this server’s node connections and relay. Connecting and accepting connections can be enabled together.')} />
    {error ? <SettingsNotice tone="error" role="alert">{error}</SettingsNotice> : null}
    {!snapshot || !draft ? <SettingsNotice role="status">{copy('正在读取 Hub 网络…', 'Loading Hub network…')}</SettingsNotice> : <>
      <SettingsSection title={copy('本节点', 'This node')}>
        <SettingsGroup>
          <SettingsRow label={copy('节点 ID', 'Hub ID')}><code className="hub-network-settings__id">{snapshot.hubId}</code></SettingsRow>
          {snapshot.authority ? <SettingsRow label={copy('已信任的登录来源', 'Trusted identity source')} description={`${snapshot.authority.issuer} · ${snapshot.authority.providers.join(', ')}`}>
            {snapshot.localService ? <SettingsButton disabled={pending} onClick={() => void action('untrust')}>{copy('撤销信任并停止发布', 'Revoke trust and stop publishing')}</SettingsButton> : null}
          </SettingsRow> : null}
          <SettingsRow label={copy('名称', 'Name')}><SettingsTextInput aria-label={copy('节点名称', 'Node name')} value={draft.name} onChange={e => setDraft({ ...draft, name: e.currentTarget.value })} /></SettingsRow>
          <SettingsRow label={copy('接入地址', 'Connection endpoint')} description={copy('其他节点可访问的 HTTPS 地址。接入邀请会携带此地址。', 'A reachable HTTPS address for other nodes. Invitations include this endpoint.')}>
            <SettingsTextInput aria-label={copy('接入地址', 'Connection endpoint')} placeholder="https://hub.example.com" value={draft.endpoint} onChange={e => setDraft({ ...draft, endpoint: e.currentTarget.value })} />
          </SettingsRow>
          {snapshot.localService ? <SettingsRow label={copy('本地服务访问地址', 'Local service address')} description={copy('可选。由入口管理员分配；使用入口选择服务器无需新增 DNS，独立域名访问才需要解析。连接本身不授予服务权限。', 'Optional. Assigned by the ingress administrator. Entry server selection needs no new DNS; direct domain access needs DNS. Connectivity does not grant service access.')}>
            <SettingsTextInput aria-label={copy('本地服务访问地址', 'Local service address')} placeholder="https://team.example.com" value={draft.origin} onChange={e => setDraft({ ...draft, origin: e.currentTarget.value })} />
          </SettingsRow> : null}
          <SettingsRow label={copy('允许其他 Hub 接入', 'Accept other Hubs')}><SettingsSwitch label={copy('允许其他 Hub 接入', 'Accept other Hubs')} checked={draft.accepting} onCheckedChange={value => setDraft({ ...draft, accepting: value })} /></SettingsRow>
          <SettingsRow label={copy('为其他节点转发', 'Forward for other nodes')} description={copy('只转发邀请允许的目标；停用会断开现有中继流。', 'Forward only targets allowed by invitations. Disabling retires active relay streams.')}>
            <SettingsSwitch label={copy('为其他节点转发', 'Forward for other nodes')} checked={draft.forwarding} onCheckedChange={value => setDraft({ ...draft, forwarding: value })} />
          </SettingsRow>
        </SettingsGroup>
        <SettingsActions><SettingsButton variant="primary" disabled={pending} onClick={() => void action('configure', draft)}>{copy('保存配置', 'Save configuration')}</SettingsButton></SettingsActions>
      </SettingsSection>
      <SettingsSection title={copy('连接其他 Hub', 'Connect to another Hub')}>
        <SettingsGroup><SettingsRow layout="stacked" label={copy('接入邀请', 'Connection invitation')}>
          <textarea className="settings-control-input hub-network-settings__invitation" aria-label={copy('接入邀请', 'Connection invitation')} autoComplete="off" spellCheck={false} value={invitation} onChange={e => { setInvitation(e.currentTarget.value); setPreview(null); setTrusted(false); }} />
        </SettingsRow></SettingsGroup>
        <SettingsActions><SettingsButton disabled={pending || !invitation.trim()} onClick={() => void action('inspect', { invitation: invitation.trim() })}>{copy('检查邀请', 'Inspect invitation')}</SettingsButton></SettingsActions>
        {preview ? <SettingsGroup>
          <SettingsRow label={preview.name} description={preview.endpoint}><code className="hub-network-settings__id">{preview.hubId}</code></SettingsRow>
          <SettingsRow label={copy('节点指纹', 'Node fingerprint')}><code>{preview.fingerprint}</code></SettingsRow>
          {preview.authority ? <SettingsRow label={copy('信任登录来源', 'Trust identity source')} description={`${preview.authority.issuer} · ${preview.authority.providers.join(', ')}`}>
            <SettingsSwitch label={copy('信任邀请中的登录来源', 'Trust the invitation’s identity source')} checked={trusted} onCheckedChange={setTrusted} />
          </SettingsRow> : null}
          {snapshot.localService ? <SettingsRow label={copy('发布本地服务', 'Publish local service')}><SettingsSelect aria-label={copy('发布本地服务', 'Publish local service')} value={publishOrigin} onChange={e => setPublishOrigin(e.currentTarget.value)}>
            <option value="">{copy('仅建立连接', 'Connect only')}</option>{preview.origins.map(origin => <option key={origin} value={origin}>{origin}</option>)}
          </SettingsSelect></SettingsRow> : null}
          <SettingsActions><SettingsButton variant="primary" disabled={pending || (!!preview.authority && !trusted)} onClick={() => void action('connect', { invitation: invitation.trim(), trustIdentity: trusted, publishOrigin })}>{copy('连接 Hub', 'Connect Hub')}</SettingsButton></SettingsActions>
        </SettingsGroup> : null}
      </SettingsSection>
      <SettingsSection title={copy('邀请其他 Hub', 'Invite another Hub')} description={copy('邀请有效期为 24 小时，仅首次展示，可撤销；每个邀请绑定一个节点。', 'Invitations expire after 24 hours, are shown once and can be revoked. Each invitation binds one node.')}>
        <SettingsGroup>
          <SettingsRow layout="stacked" label={copy('允许发布的访问地址', 'Allowed service addresses')} description={copy('每行一个完整地址，留空仅允许节点连接。通过入口选择服务器时无需新增 DNS；独立域名访问由入口管理员配置解析和转发。', 'One full origin per line. Leave empty for connectivity only. Entry server selection needs no new DNS; the ingress administrator configures DNS and routing for direct domain access.')}>
            <textarea className="settings-control-input hub-network-settings__invitation" aria-label={copy('允许发布的访问地址', 'Allowed service addresses')} value={origins} onChange={e => setOrigins(e.currentTarget.value)} />
          </SettingsRow>
          <SettingsRow label={copy('允许转发其下级节点', 'Allow descendant forwarding')}><SettingsSwitch label={copy('允许转发其下级节点', 'Allow descendant forwarding')} checked={transit} onCheckedChange={setTransit} /></SettingsRow>
        </SettingsGroup>
        <SettingsActions><SettingsButton disabled={pending || !snapshot.accepting} onClick={() => void action('invite', { origins: origins.split(/\r?\n/u).map(o => o.trim()).filter(Boolean), allowTransit: transit })}>{copy('生成邀请', 'Create invitation')}</SettingsButton></SettingsActions>
        {generated ? <SettingsGroup><SettingsRow layout="stacked" label={copy('接入邀请，请复制保存', 'Connection invitation — copy and save')} description={copy('邀请包含连接凭据，请只交给目标节点管理员。', 'This invitation contains a connection credential. Share only with the intended node administrator.')}>
          <textarea readOnly className="settings-control-input hub-network-settings__invitation" aria-label={copy('生成的邀请', 'Generated invitation')} value={generated} onFocus={e => e.currentTarget.select()} />
          <SettingsButton onClick={() => setGenerated('')}>{copy('关闭邀请', 'Dismiss invitation')}</SettingsButton>
        </SettingsRow></SettingsGroup> : null}
        {snapshot.invitations.filter(i => !i.redeemed).map(i => <SettingsRow key={i.id} label={i.origins.join(', ') || copy('仅连接', 'Connectivity only')} description={new Date(i.expiresAt).toLocaleString(intl.locale)}>
          <SettingsButton disabled={pending} onClick={() => void action('revoke', { id: i.id })}>{copy('撤销邀请', 'Revoke invitation')}</SettingsButton>
        </SettingsRow>)}
      </SettingsSection>
      <SettingsSection title={copy('已配置的连接', 'Configured connections')}>
        {snapshot.peers.length ? <SettingsGroup>{snapshot.peers.map(peer => <SettingsRow key={peer.id} label={peer.name} description={`${peer.direction === 'incoming' ? copy('接入本节点', 'Incoming') : copy('连接到其他节点', 'Outgoing')} · ${peer.connected ? copy('已连接', 'Connected') : copy('未连接', 'Disconnected')} · ${peer.hubId}`}>
          <SettingsButton disabled={pending} onClick={() => void action(peer.direction === 'incoming' ? 'revoke' : 'disconnect', { id: peer.id })}>{copy('断开并移除', 'Disconnect and remove')}</SettingsButton>
        </SettingsRow>)}</SettingsGroup> : <SettingsNotice>{copy('尚未配置节点连接。', 'No node connections configured.')}</SettingsNotice>}
      </SettingsSection>
      <SettingsSection title={copy('可达服务与路由', 'Reachable services and routes')}>
        {snapshot.routes.length ? <SettingsGroup>{snapshot.routes.map(route => <SettingsRow key={route.hubId} layout="stacked" label={route.origin} description={route.hubId}>
          <code className="hub-network-settings__id">{route.path.join(' → ')}</code>
        </SettingsRow>)}</SettingsGroup> : <SettingsNotice>{copy('当前没有可达的远端服务。', 'No remote services are currently reachable.')}</SettingsNotice>}
      </SettingsSection>
      <SettingsSection title={copy('最近变更', 'Recent changes')}><SettingsGroup>{snapshot.audit.slice(0, 5).map((entry, i) => <SettingsRow key={`${entry.at}-${i}`} label={actionLabel(entry.action)} description={new Date(entry.at).toLocaleString(intl.locale)}><span className="hub-network-settings__id">{entry.operator}</span></SettingsRow>)}</SettingsGroup></SettingsSection>
    </>}
  </div>;
}
