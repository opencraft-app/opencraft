import { combineAbortSignals } from '@opencraft/appserver-client/transport';
import { ModalContent } from "@opencraft/design-system-web/modal-content";
import * as Dialog from '@radix-ui/react-dialog';
import { Activity, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ChannelInviteCandidate, ChannelMember, ChannelSummary } from '@opencraft/appserver-protocol';
import { AddIcon, MoreIcon, ChevronLeftIcon, MinusIcon } from '@opencraft/design-system-web/action-icons';
import { Button, IconButton } from '@opencraft/design-system-web/button';
import { SettingsGroup, SettingsNavigationRow, SettingsPanel, SettingsTextInput, SettingsRow, type ExtensionSettingsViewProps } from '@opencraft/extension-react';
import { useIntl } from '@opencraft/i18n/react';
import type { ChannelsClient } from './channel-client';
import { ChatAvatar } from './channel-chat-ui';
import { GroupSyncPanel, groupSyncSummary, useGroupSync } from './channel-group-sync';

const labels = {
  details: { id: 'im.channels.group.details', defaultMessage: 'Group details' },
  edit: { id: 'im.channels.group.edit', defaultMessage: 'Edit name' },
  addMembers: { id: 'im.channels.group.addMembers', defaultMessage: 'Add members' },
  count: { id: 'im.channels.group.count', defaultMessage: '{count} members' },
  create: { id: 'im.channels.group.create', defaultMessage: 'New group chat' },
  createAction: { id: 'im.channels.group.createAction', defaultMessage: 'Create group' },
  name: { id: 'im.channels.group.name', defaultMessage: 'Group name' },
  search: { id: 'im.channels.group.search', defaultMessage: 'Search people and bots' },
  candidates: { id: 'im.channels.group.candidates', defaultMessage: 'People and bots' },
  members: { id: 'im.channels.group.members', defaultMessage: 'Members' },
  bot: { id: 'im.channels.group.bot', defaultMessage: 'Bot' },
  person: { id: 'im.channels.group.person', defaultMessage: 'Person' },
  owner: { id: 'im.channels.group.owner', defaultMessage: 'Owner' },
  selected: { id: 'im.channels.group.selected', defaultMessage: 'Selected ({count})' },
  none: { id: 'im.channels.group.noCandidates', defaultMessage: 'No people or bots found.' },
  loading: { id: 'im.channels.group.loading', defaultMessage: 'Loading…' },
  loadFailed: { id: 'im.channels.group.loadFailed', defaultMessage: 'Could not load the list.' },
  retry: { id: 'im.channels.group.retry', defaultMessage: 'Retry' },
  add: { id: 'im.channels.group.add', defaultMessage: 'Add' },
  addNamed: { id: 'im.channels.group.addNamed', defaultMessage: 'Add {name}' },
  remove: { id: 'im.channels.group.remove', defaultMessage: 'Remove' },
  removeNamed: { id: 'im.channels.group.removeNamed', defaultMessage: 'Remove {name}' },
  cancel: { id: 'im.channels.group.cancel', defaultMessage: 'Cancel' },
  done: { id: 'im.channels.group.done', defaultMessage: 'Done' },
  createFailed: { id: 'im.channels.group.createFailed', defaultMessage: 'Could not create the group. Try again.' },
  memberFailed: { id: 'im.channels.group.memberFailed', defaultMessage: 'Could not update this member. Try again.' },
  settings: { id: 'im.channels.group.settings', defaultMessage: 'Group settings' },
  save: { id: 'im.channels.group.save', defaultMessage: 'Save' },
  saved: { id: 'im.channels.group.saved', defaultMessage: 'Group name saved.' },
  renameFailed: { id: 'im.channels.group.renameFailed', defaultMessage: 'Could not rename the group. Try again.' },
  chatInfo: { id: 'im.channels.group.chatInfo', defaultMessage: 'Chat info ({count})' },
  allMembers: { id: 'im.channels.group.allMembers', defaultMessage: 'View all members' },
  memberCount: { id: 'im.channels.group.memberCount', defaultMessage: '{count} people' },
  removeMembers: { id: 'im.channels.group.removeMembers', defaultMessage: 'Remove members' },
  addCount: { id: 'im.channels.group.addCount', defaultMessage: 'Add ({count})' },
  sync: { id: 'im.channels.group.sync.title', defaultMessage: 'External group connection' },
  back: { id: 'im.channels.group.back', defaultMessage: 'Back' },
  close: { id: 'im.channels.group.close', defaultMessage: 'Close' },
} as const;

type ReportError = ExtensionSettingsViewProps['reportError'];

function GroupDialog({ title, footer, busy, children, details = false, panel = false, onBack }: { title: string; footer: ReactNode; busy: boolean; children: ReactNode; details?: boolean; panel?: boolean; onBack?: () => void }) {
  return <ModalContent overlayClassName={"modal-surface__scrim"} overlayProps={{"data-appearance":"utility"}} className="modal-surface im-channel-group-dialog" data-appearance="utility" data-size="default"
      data-presentation={details ? "inspector" : undefined}
      aria-describedby={undefined}
      onEscapeKeyDown={event => { if (busy || event.isComposing || event.keyCode === 229) { event.preventDefault(); return; } if (onBack) { event.preventDefault(); onBack(); } }}
      onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
      {panel ? <><Dialog.Title className="modal-surface__accessible-title">{title}</Dialog.Title>{children}</> : <SettingsPanel title={<Dialog.Title asChild><span>{title}</span></Dialog.Title>} actions={details ? footer : undefined} footer={details ? undefined : footer}>{children}</SettingsPanel>}
    </ModalContent>;
}

function ActorName({ actor, owner = false }: { actor: ChannelInviteCandidate; owner?: boolean }) {
  const intl = useIntl();
  return <span className="im-channel-group-dialog__identity">
    <strong>{actor.displayName}</strong>
    <small>{intl.formatMessage(owner ? labels.owner : actor.actorKind === 'session' ? labels.bot : labels.person)}</small>
  </span>;
}

function CandidatePicker({ client, channelId, revision = 0, children }: {
  client: ChannelsClient; channelId?: string; revision?: number;
  children: (candidate: ChannelInviteCandidate) => ReactNode;
}) {
  const intl = useIntl();
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ query: string; candidates: ChannelInviteCandidate[] | null }>();
  const search = query.trim();
  useEffect(() => {
    const owner = new AbortController();
    void client.inviteCandidates(search, owner.signal, channelId).then(({ candidates }) => {
      if (!owner.signal.aborted) setResult({ query: search, candidates });
    }).catch(() => { if (!owner.signal.aborted) setResult({ query: search, candidates: null }); });
    return () => owner.abort();
  }, [client, channelId, search, revision, retry]);
  const candidates = result?.query === search ? result.candidates : undefined;
  return <div className="im-channel-group-dialog__picker">
    <label htmlFor={searchId}>{intl.formatMessage(labels.search)}</label>
    <SettingsTextInput id={searchId} type="search" value={query} maxLength={128} onChange={event => setQuery(event.currentTarget.value)} />
    <div className="im-channel-group-dialog__results">
      {candidates?.length ? <ul aria-label={intl.formatMessage(labels.candidates)}>
        {candidates.map(candidate => <li key={candidate.actorId}>{children(candidate)}</li>)}
      </ul> : <p role="status">{intl.formatMessage(candidates === undefined ? labels.loading : candidates === null ? labels.loadFailed : labels.none)}</p>}
      {candidates === null && <Button variant="ghost" onClick={() => { setResult(undefined); setRetry(value => value + 1); }}>
        {intl.formatMessage(labels.retry)}
      </Button>}
    </div>
  </div>;
}

function CreateGroupForm({ client, busy, setBusy, reportError, onCreated }: {
  client: ChannelsClient; busy: boolean; setBusy: (busy: boolean) => void;
  reportError: ReportError; onCreated: (group: ChannelSummary) => void;
}) {
  const intl = useIntl();
  const formId = useId();
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<ChannelInviteCandidate[]>([]);
  const attempt = useRef<{ key: string; payload: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function create() {
    // An empty title takes the first members' names, as message apps do.
    const name = (title.trim() || selected.slice(0, 3).map(actor => actor.displayName).join('、')).slice(0, 128);
    if (!name || !selected.length || request.current) return;
    const ids = selected.map(actor => actor.actorId).sort();
    const payload = JSON.stringify([name, ids]);
    const key = attempt.current?.payload === payload ? attempt.current.key : crypto.randomUUID();
    attempt.current = { key, payload };
    const owner = new AbortController();
    request.current = owner;
    setBusy(true);
    try {
      const group = await client.createGroup(name, ids, key, owner.signal);
      if (!owner.signal.aborted) onCreated(group);
    } catch {
      if (!owner.signal.aborted) reportError?.({ key: 'create-channel', message: intl.formatMessage(labels.createFailed) });
    } finally {
      if (!owner.signal.aborted) setBusy(false);
      request.current = null;
    }
  }
  return <GroupDialog title={intl.formatMessage(labels.create)} busy={busy} footer={<>
    <Dialog.Close asChild><Button variant="secondary" disabled={busy}>{intl.formatMessage(labels.cancel)}</Button></Dialog.Close>
    <Button variant="primary" type="submit" form={formId} loading={busy} disabled={!selected.length}>{intl.formatMessage(labels.createAction)}</Button>
  </>}>
    <form id={formId} className="im-channel-group-dialog__form" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label htmlFor={formId + '-name'}>{intl.formatMessage(labels.name)}</label>
      <SettingsTextInput id={formId + '-name'} value={title} maxLength={128} disabled={busy} placeholder={selected.slice(0, 3).map(actor => actor.displayName).join('、')} onChange={event => setTitle(event.currentTarget.value)} />
      {selected.length > 0 && <ul className="im-channel-group-dialog__selection" aria-label={intl.formatMessage(labels.selected, { count: selected.length })}>
        {selected.map(actor => <li key={actor.actorId}>
          <ChatAvatar id={actor.actorId} label={actor.displayName} avatar={actor.avatar} bot={actor.actorKind === 'session'} />
          <ActorName actor={actor} />
          <Button variant="ghost" size="sm" type="button" disabled={busy}
            aria-label={intl.formatMessage(labels.removeNamed, { name: actor.displayName })}
            onClick={() => setSelected(previous => previous.filter(item => item.actorId !== actor.actorId))}>{intl.formatMessage(labels.remove)}</Button>
        </li>)}
      </ul>}
      <CandidatePicker client={client}>{actor => {
        const checked = selected.some(item => item.actorId === actor.actorId);
        return <label className="im-channel-group-dialog__choice">
          <ChatAvatar id={actor.actorId} label={actor.displayName} avatar={actor.avatar} bot={actor.actorKind === 'session'} />
          <ActorName actor={actor} />
          <input type="checkbox" checked={checked} disabled={busy || (!checked && selected.length === 63)}
            onChange={event => { const pick = event.currentTarget.checked; setSelected(previous => pick ? [...previous, actor] : previous.filter(item => item.actorId !== actor.actorId)); }} />
        </label>;
      }}</CandidatePicker>
    </form>
  </GroupDialog>;
}

export function CreateGroupButton({ client, reportError, onCreated }: {
  client: ChannelsClient; reportError: ReportError; onCreated: (group: ChannelSummary) => void;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return <Dialog.Root open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
    <Dialog.Trigger asChild><IconButton aria-label={intl.formatMessage(labels.create)} title={intl.formatMessage(labels.create)}>
      <AddIcon size={16} />
    </IconButton></Dialog.Trigger>
    {open && <CreateGroupForm client={client} busy={busy} setBusy={setBusy} reportError={reportError}
      onCreated={group => { setBusy(false); setOpen(false); onCreated(group); }} />}
  </Dialog.Root>;
}

function GroupNameForm({ client, group, reportError, busy, setBusy, onSaved, onCancel, inputRef }: {
  client: ChannelsClient; group: ChannelSummary; reportError: ReportError;
  busy: boolean; setBusy: (busy: boolean) => void; onSaved: (name: string) => void; onCancel: () => void; inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const intl = useIntl();
  const formId = useId();
  const [name, setName] = useState(group.title);
  const [saving, setSaving] = useState(false);
  const localInput = useRef<HTMLInputElement>(null);
  const input = inputRef ?? localInput;
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const known = useRef(group.title);
  const attempt = useRef<{ key: string; title: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  // Follow a rename from another device unless this field holds an unsaved edit.
  useEffect(() => {
    setName(current => current === known.current ? group.title : current);
    known.current = group.title;
  }, [group.title]);
  const title = name.trim();
  async function save() {
    if (!title || title === group.title || request.current) return;
    const key = attempt.current?.title === title ? attempt.current.key : crypto.randomUUID();
    attempt.current = { key, title };
    const owner = new AbortController();
    request.current = owner;
    setBusy(true);
    setSaving(true);

    try {
      const renamed = await client.rename(group.id, title, key, owner.signal);
      if (owner.signal.aborted) return;
      attempt.current = null;
      known.current = renamed.title;
      setName(renamed.title);
      onSaved(renamed.title);

    } catch {
      if (!owner.signal.aborted) reportError?.({ key: 'rename-' + group.id, message: intl.formatMessage(labels.renameFailed) });
    } finally {
      if (!owner.signal.aborted) { setBusy(false); setSaving(false); }
      request.current = null;
    }
  }
  return <div className="im-channel-group-dialog__name-page"><SettingsPanel
    title={<span>{intl.formatMessage(labels.edit)}</span>}
    actions={<>
      <Button className="im-channel-group-dialog__cancel-name" variant="ghost" disabled={busy} onClick={onCancel}>{intl.formatMessage(labels.cancel)}</Button>
      <Button variant="primary" type="submit" form={formId} loading={saving} disabled={busy || !title || title === group.title}>{intl.formatMessage(labels.save)}</Button>
    </>}>
    <form id={formId} className="im-channel-group-dialog__name-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label htmlFor={formId + '-name'}>{intl.formatMessage(labels.name)}</label>
      <SettingsTextInput ref={input} id={formId + '-name'} value={name} maxLength={128} disabled={busy} required
        onKeyDown={event => { if (event.key === "Escape" && !busy && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onCancel(); } }}
        onChange={event => setName(event.currentTarget.value)} />
    </form>
  </SettingsPanel></div>;
}

/** Sub-page chrome: a leading back control and a centred title. */
function GroupPage({ title, onBack, busy, actions, children, root = false }: {
  title: string; onBack?: () => void; busy: boolean; actions?: ReactNode; children: ReactNode; root?: boolean;
}) {
  const intl = useIntl();
  const back = <IconButton className="im-channel-group-dialog__back" aria-label={intl.formatMessage(root ? labels.close : labels.back)} disabled={busy} onClick={onBack}><ChevronLeftIcon /></IconButton>;
  return <div className="im-channel-group-dialog__page">
    <SettingsPanel title={<span>{title}</span>}
      actions={<>{root ? <Dialog.Close asChild>{back}</Dialog.Close> : back}{actions ?? <span className="im-channel-group-dialog__header-spacer" aria-hidden="true" />}</>}>
      <div className="im-channel-group-dialog__cards">{children}</div>
    </SettingsPanel>
  </div>;
}

/** Roster tile grid with optional add/remove tiles, using the shared chat-info composition. */
function MemberGrid({ members, canManage, removing, busy, pendingActor, onAdd, onToggleRemove, onRemove }: {
  members: readonly ChannelMember[]; canManage: boolean; removing: boolean; busy: boolean; pendingActor?: string;
  onAdd: () => void; onToggleRemove: () => void; onRemove: (member: ChannelMember) => void;
}) {
  const intl = useIntl();
  return <ul className="im-member-grid" aria-label={intl.formatMessage(labels.members)}>
    {members.map(member => <li key={member.actorId} className="im-member-grid__cell">
      <span className="im-member-grid__tile"><ChatAvatar id={member.actorId} label={member.displayName} avatar={member.avatar} bot={member.actorKind === 'session'} /></span>
      <span className="im-member-grid__name" title={member.displayName}>{member.displayName}</span>
      {removing && member.role !== 'owner' && <button type="button" className="im-member-grid__remove" disabled={busy}
        aria-busy={pendingActor === member.actorId || undefined} aria-label={intl.formatMessage(labels.removeNamed, { name: member.displayName })}
        onClick={() => onRemove(member)}><MinusIcon /></button>}
    </li>)}
    {canManage && <li className="im-member-grid__cell">
      <button type="button" className="im-member-grid__tile im-member-grid__tile--action" disabled={busy} aria-label={intl.formatMessage(labels.addMembers)} onClick={onAdd}><AddIcon /></button>
      <span className="im-member-grid__name">{intl.formatMessage(labels.add)}</span>
    </li>}
    {canManage && members.some(member => member.role !== 'owner') && <li className="im-member-grid__cell">
      <button type="button" className="im-member-grid__tile im-member-grid__tile--action" aria-pressed={removing} disabled={busy} aria-label={intl.formatMessage(labels.removeMembers)} onClick={onToggleRemove}><MinusIcon /></button>
      <span className="im-member-grid__name">{intl.formatMessage(removing ? labels.done : labels.remove)}</span>
    </li>}
  </ul>;
}


const lifecycleLabels = {
  leave: {id:"im.channels.group.lifecycle.leave",defaultMessage:"Leave group"},
  dissolve: {id:"im.channels.group.lifecycle.dissolve",defaultMessage:"Dissolve group"},
  conflict: {id:"im.channels.group.lifecycle.conflict",defaultMessage:"The group changed. Review its latest details before confirming again."},
  failed: {id:"im.channels.group.lifecycle.failed",defaultMessage:"The result could not be confirmed. Retry to check the same operation; do not assume it failed."},
  closed: {id:"im.channels.group.lifecycle.closed",defaultMessage:"This group is dissolved. Existing members can read its history; new messages and invitations are disabled."},
  list: {id:"im.channels.group.lifecycle.list",defaultMessage:"My conversation list"},
  hideHint: {id:"im.channels.group.lifecycle.hideHint",defaultMessage:"Only your list changes, across devices. Membership and history stay intact. A direct link can reopen this group."},
  restore: {id:"im.channels.group.lifecycle.restore",defaultMessage:"Show in Inbox"},
  hide: {id:"im.channels.group.lifecycle.hide",defaultMessage:"Hide from Inbox"},
  membership: {id:"im.channels.group.lifecycle.membership",defaultMessage:"Group membership"},
  ownerHint: {id:"im.channels.group.lifecycle.ownerHint",defaultMessage:"The owner cannot leave. Keep the group or dissolve it for everyone. Ownership transfer is not available yet."},
  leaveHint: {id:"im.channels.group.lifecycle.leaveHint",defaultMessage:"You will lose access to this group, its history and attachments. Your pending group requests lose their authorization. Other members are not affected."},
  dissolveHint: {id:"im.channels.group.lifecycle.dissolveHint",defaultMessage:"This permanently closes the OpenCraft group for everyone. Messages, invitations and group-scoped requests stop. Existing members retain read-only history; people who already left do not regain access."},
  boundary: {id:"im.channels.group.lifecycle.boundary",defaultMessage:"This does not leave or dissolve the linked external group. Bots, environments and work in other conversations are not deleted or stopped."},
} as const;

/** Personal presentation and native membership are intentionally separate actions. */
function GroupLifecycleControls({client,group,busy,setBusy,onRemoved,onUpdated}:{
  client:ChannelsClient;group:ChannelSummary;busy:boolean;setBusy(v:boolean):void;
  onRemoved?():void;onUpdated(group:ChannelSummary):void;
}) {
  const intl=useIntl(),life=group.lifecycle;
  const [confirm,setConfirm]=useState<'leave'|'dissolve'>(),[error,setError]=useState<string>();
  const pending=useRef<AbortController|null>(null),attempt=useRef<{payload:string;key:string}|undefined>(undefined);
  const cancel=useRef<HTMLButtonElement>(null),trigger=useRef<HTMLButtonElement>(null),confirmedRevision=useRef(0),wasConfirming=useRef(false);
  useEffect(()=>()=>pending.current?.abort(),[]);
  useEffect(()=>{if(life?.state==='dissolved'){setConfirm(undefined);attempt.current=undefined;}},[life?.state]);
  useEffect(()=>{if(confirm)cancel.current?.focus();else if(wasConfirming.current)trigger.current?.focus();wasConfirming.current=!!confirm;},[confirm]);
  if(!life)return null; // Older servers do not advertise destructive capabilities.
  const message=(id:keyof typeof lifecycleLabels)=>intl.formatMessage(lifecycleLabels[id]);
  const action=confirm==='leave'?message('leave'):message('dissolve');
  async function run(kind:'hide'|'leave'|'dissolve') {
    if(pending.current)return;
    const payload=JSON.stringify([group.id,kind,kind==='hide'?!group.listState?.hidden:kind==='dissolve'?confirmedRevision.current:null]);
    if(attempt.current?.payload!==payload)attempt.current={payload,key:crypto.randomUUID()};
    const owner=new AbortController(),request=combineAbortSignals([owner.signal,AbortSignal.timeout(15000)]);pending.current=owner;setBusy(true);setError(undefined);
    try {
      let updated:ChannelSummary|undefined;
      if(kind==='hide')updated=await client.setGroupHidden(group.id,!group.listState?.hidden,attempt.current.key,request.signal);
      else if(kind==='leave')await client.leaveGroup(group.id,attempt.current.key,request.signal);
      else updated=await client.dissolveGroup(group.id,confirmedRevision.current,attempt.current.key,request.signal);
      if(owner.signal.aborted)return;
      attempt.current=undefined;setConfirm(undefined);
      if(kind==='leave')onRemoved?.();
      else if(updated)onUpdated(updated);
    } catch(failure) {
      if(owner.signal.aborted)return;
      if(failure instanceof Error&&failure.message==='channel_revision_conflict') {
        attempt.current=undefined;setConfirm(undefined);
        setError(message('conflict'));
        try {const fresh=await client.group(group.id,request.signal);if(!owner.signal.aborted)onUpdated(fresh);} catch { /* Keep the original conflict visible. */ }
      } else setError(message('failed'));
    } finally {request.dispose();if(!owner.signal.aborted){pending.current=null;setBusy(false);}}
  }
  return <SettingsGroup className="im-channel-group-dialog__card">
    {error&&<p className="im-channel-group-dialog__lifecycle-copy" role="alert">{error}</p>}
    {life.state==='dissolved'&&<p className="im-channel-group-dialog__lifecycle-copy" role="status">{message('closed')}</p>}
    {!confirm?<>
      <SettingsRow layout="stacked" label={message('list')} description={message('hideHint')}>
        <Button variant="ghost" disabled={busy} onClick={()=>void run('hide')}>{group.listState?.hidden?message('restore'):message('hide')}</Button>
      </SettingsRow>
      {life.state==='active'&&<SettingsRow layout="stacked" label={message('membership')}
        description={life.canDissolve?message('ownerHint'):undefined}>
        {(life.canLeave||life.canDissolve)&&<Button ref={trigger} variant="danger" disabled={busy} onClick={()=>{setError(undefined);confirmedRevision.current=life.revision;setConfirm(life.canLeave?'leave':'dissolve');}}>{life.canLeave?message('leave'):message('dissolve')}</Button>}
      </SettingsRow>}
    </>:<div className="im-channel-group-dialog__lifecycle-copy" role="region" aria-label={action}>
      <h3>{action} · {group.title}</h3>
      <p>{confirm==='leave'?message('leaveHint'):message('dissolveHint')}</p>
      <p>{message('boundary')}</p>
      <div className="im-channel-group-dialog__lifecycle-actions">
        <Button ref={cancel} variant="secondary" disabled={busy} onClick={()=>{setConfirm(undefined);trigger.current?.focus();}}>{intl.formatMessage(labels.cancel)}</Button>
        <Button variant="destructive" loading={busy} onClick={()=>void run(confirm)}>{action}</Button>
      </div>
    </div>}
  </SettingsGroup>;
}

type GroupPageId = 'info' | 'name' | 'members' | 'add' | 'sync';
const GRID_PREVIEW = 13;

function GroupMembersPanel({ client, group:initialGroup, reportError, busy, setBusy, onRemoved, regions }: {
  client: ChannelsClient; group: ChannelSummary; reportError: ReportError; regions?: ExtensionSettingsViewProps["regions"];
  busy: boolean; setBusy: (busy: boolean) => void; onRemoved?:()=>void;
}) {
  const intl = useIntl();
  const [group,setGroup]=useState(initialGroup);
  const acceptGroup=(next:ChannelSummary)=>setGroup(current=>(current.lifecycle?.revision??0)>(next.lifecycle?.revision??0)?current:next);
  useEffect(()=>acceptGroup(initialGroup),[initialGroup]);
  const [members, setMembers] = useState<ChannelMember[] | null>();
  const [page, setPage] = useState<GroupPageId>('info');
  const nameInput = useRef<HTMLInputElement>(null);
  const [removing, setRemoving] = useState(false);
  const [selected, setSelected] = useState<ChannelInviteCandidate[]>([]);
  const [displayName, setDisplayName] = useState(group.title);
  const [memberRetry, setMemberRetry] = useState(0);
  useEffect(() => setDisplayName(group.title), [group.title]);
  const [pendingActor, setPendingActor] = useState<string>();
  const [revision, setRevision] = useState(0);
  const attempts = useRef(new Map<string, string>());
  const request = useRef<AbortController | null>(null);
  const sync = useGroupSync(client, group.id);
  useEffect(() => {
    const owner = new AbortController();
    client.watch(group.id, async connection => {
      const [result,summary] = await Promise.all([client.members(group.id, connection),initialGroup.lifecycle?client.group(group.id,connection):Promise.resolve(initialGroup)]);
      if (!connection.aborted){setMembers(result.members);acceptGroup(summary);}
    }, () => setMembers(null), owner.signal);
    return () => { owner.abort(); request.current?.abort(); };
  }, [client, group.id, memberRetry]);

  async function update(actorId: string, present: boolean): Promise<boolean> {
    if (request.current) return false;
    const owner = new AbortController();
    request.current = owner;
    const action = JSON.stringify([actorId, present]);
    const key = attempts.current.get(action) ?? crypto.randomUUID();
    attempts.current.set(action, key);
    setPendingActor(actorId);
    try {
      await client.setMember(group.id, actorId, present, key, owner.signal);
      if (owner.signal.aborted) return false;
      attempts.current.delete(action);
      setRevision(value => value + 1);
      return true;
    } catch {
      if (!owner.signal.aborted) reportError?.({ key: 'member-' + actorId, message: intl.formatMessage(labels.memberFailed) });
      return false;
    } finally {
      if (!owner.signal.aborted) setPendingActor(undefined);
      request.current = null;
    }
  }
  async function run(work: () => Promise<void>) { setBusy(true); try { await work(); } finally { setBusy(false); } }
  const remove = (member: ChannelMember) => void run(async () => { await update(member.actorId, false); });
  const addSelected = () => void run(async () => {
    const remaining: ChannelInviteCandidate[] = [];
    for (const actor of selected) if (!await update(actor.actorId, true)) remaining.push(actor);
    setSelected(remaining);
    if (!remaining.length) setPage('info');
  });
  const toggle = (actor: ChannelInviteCandidate) => setSelected(current => current.some(item => item.actorId === actor.actorId)
    ? current.filter(item => item.actorId !== actor.actorId) : [...current, actor]);
  const count = members?.length;
  const syncValue = groupSyncSummary(intl, sync);
  const canManage = group.canManageMembers === true;
  const loading = members ? null : <p role="status">{intl.formatMessage(members === null ? labels.loadFailed : labels.loading)}
    {members === null && <Button variant="ghost" onClick={() => setMemberRetry(value => value + 1)}>{intl.formatMessage(labels.retry)}</Button>}</p>;
  const home = () => setPage('info');

  const title = intl.formatMessage(page === 'name' ? labels.edit : page === 'add' ? labels.addMembers
    : page === 'sync' ? labels.sync : page === 'members' ? labels.members : labels.details);
  const NavigationStack = regions?.NavigationStack;
  const pages = <>

    {page === 'name' && <GroupNameForm inputRef={nameInput} client={client} group={{ ...group, title: displayName }} reportError={reportError} busy={busy} setBusy={setBusy}
      onCancel={home} onSaved={name => { setDisplayName(name); home(); }} />}

    <Activity mode={page === 'info' ? 'visible' : 'hidden'}><GroupPage root busy={busy} title={count === undefined ? intl.formatMessage(labels.details) : intl.formatMessage(labels.chatInfo, { count })}>
      <SettingsGroup className="im-channel-group-dialog__card">
        {members ? <MemberGrid members={members.slice(0, GRID_PREVIEW)} canManage={canManage} removing={removing} busy={busy} pendingActor={pendingActor}
          onAdd={() => { setRemoving(false); setSelected([]); setPage('add'); }} onToggleRemove={() => setRemoving(value => !value)} onRemove={remove} /> : loading}
        <SettingsNavigationRow label={intl.formatMessage(labels.allMembers)} value={count === undefined ? undefined : intl.formatMessage(labels.memberCount, { count })}
          disabled={!members} onClick={() => { setRemoving(false); setPage('members'); }} />
      </SettingsGroup>
      <SettingsGroup className="im-channel-group-dialog__card">
        {group.canRename
          ? <SettingsNavigationRow label={intl.formatMessage(labels.name)} value={displayName} disabled={busy} onClick={() => setPage('name')} />
          : <div className="settings-control-row"><span className="settings-control-row__label">{intl.formatMessage(labels.name)}</span><span className="settings-navigation-row__value">{displayName}</span></div>}
        {syncValue !== null && <SettingsNavigationRow label={intl.formatMessage(labels.sync)}
          value={<><span className="im-channel-group-dialog__sync-dot" data-state={sync.loadFailed || sync.requestFailed ? 'error' : sync.status?.state} aria-hidden="true" />{syncValue}</>}
          onClick={() => setPage('sync')} />}
      </SettingsGroup>
      <GroupLifecycleControls client={client} group={group} busy={busy} setBusy={setBusy} onRemoved={onRemoved} onUpdated={acceptGroup} />
    </GroupPage></Activity>

    {page === 'members' && <GroupPage busy={busy} onBack={home} title={count === undefined ? intl.formatMessage(labels.members) : intl.formatMessage(labels.memberCount, { count })}>
      <SettingsGroup className="im-channel-group-dialog__card">
        {members ? <ul className="im-channel-group-dialog__members" aria-label={intl.formatMessage(labels.members)}>
          {members.map(member => <li key={member.actorId}>
            <ChatAvatar id={member.actorId} label={member.displayName} avatar={member.avatar} bot={member.actorKind === 'session'} /><ActorName actor={member} owner={member.role === 'owner'} />
            {canManage && member.role !== 'owner' && <Button variant="ghost" size="sm" disabled={busy}
              loading={pendingActor === member.actorId} aria-label={intl.formatMessage(labels.removeNamed, { name: member.displayName })}
              onClick={() => remove(member)}>{intl.formatMessage(labels.remove)}</Button>}
          </li>)}
        </ul> : loading}
      </SettingsGroup>
    </GroupPage>}

    {page === 'add' && canManage && <GroupPage busy={busy} onBack={home} title={intl.formatMessage(labels.addMembers)}
      actions={<Button variant="primary" size="sm" disabled={busy || !selected.length} loading={busy} onClick={addSelected}>
        {intl.formatMessage(labels.addCount, { count: selected.length })}</Button>}>
      {selected.length > 0 && <ul className="im-channel-group-dialog__selection" aria-label={intl.formatMessage(labels.selected, { count: selected.length })}>
        {selected.map(actor => <li key={actor.actorId}><button type="button" className="im-channel-group-dialog__chip" disabled={busy}
          aria-label={intl.formatMessage(labels.removeNamed, { name: actor.displayName })} onClick={() => toggle(actor)}>
          <ChatAvatar id={actor.actorId} label={actor.displayName} avatar={actor.avatar} bot={actor.actorKind === 'session'} />{actor.displayName}</button></li>)}
      </ul>}
      <CandidatePicker client={client} channelId={group.id} revision={revision}>{actor => {
        const checked = selected.some(item => item.actorId === actor.actorId);
        return <label className="im-channel-group-dialog__choice">
          <ChatAvatar id={actor.actorId} label={actor.displayName} avatar={actor.avatar} bot={actor.actorKind === 'session'} />
          <ActorName actor={actor} />
          <input type="checkbox" className="im-channel-group-dialog__check" checked={checked} disabled={busy} onChange={() => toggle(actor)} />
        </label>;
      }}</CandidatePicker>
    </GroupPage>}

    {page === 'sync' && <GroupPage busy={busy} onBack={home} title={intl.formatMessage(labels.sync)}>
      <SettingsGroup className="im-channel-group-dialog__card im-channel-group-dialog__card--padded"><GroupSyncPanel sync={sync} /></SettingsGroup>
    </GroupPage>}
  </>;
  return <GroupDialog details panel title={title} busy={busy} footer={null} onBack={page === 'info' ? undefined : home}>
    {NavigationStack ? <NavigationStack focusTarget={page === 'name' ? nameInput : undefined} path={page === 'info' ? ['info'] : ['info', page]} onBack={home} disabled={busy}>{pages}</NavigationStack> : pages}
  </GroupDialog>;
}

export function GroupMembersButton({ client, group, reportError, onRemoved, regions }: {
  client: ChannelsClient; group: ChannelSummary; reportError: ReportError; onRemoved?:()=>void; regions?: ExtensionSettingsViewProps["regions"];
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Read the authorized native roster, never infer membership from message senders
  // or an external provider snapshot (which may only be observation-only).
  const [roster, setRoster] = useState<{ channelId: string; count: number }>();
  useEffect(() => {
    const owner = new AbortController();
    setRoster(undefined);
    const clear = () => { if (!owner.signal.aborted) setRoster(undefined); };
    client.watch(group.id, async connection => {
      const result = await client.members(group.id, connection);
      if (!owner.signal.aborted && !connection.aborted) {
        setRoster({ channelId: group.id, count: result.members.length });
      }
    }, clear, owner.signal, { onConnectionLost: clear });
    return () => owner.abort();
  }, [client, group.id]);
  const count = roster?.channelId === group.id ? roster.count : undefined;
  const description = count === undefined ? undefined : intl.formatMessage(labels.count, { count });
  return <Dialog.Root open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
    <Dialog.Trigger asChild><IconButton size="chrome" aria-label={intl.formatMessage(labels.settings)} aria-description={description} title={intl.formatMessage(labels.settings)}><MoreIcon /></IconButton></Dialog.Trigger>
    {open && <GroupMembersPanel regions={regions} client={client} group={group} reportError={reportError} busy={busy} setBusy={setBusy} onRemoved={()=>{setBusy(false);setOpen(false);onRemoved?.();}} />}
  </Dialog.Root>;
}
