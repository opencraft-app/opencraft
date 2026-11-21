import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ActorContext } from '@opencraft/identity-core/actors';
import type { ActorStore } from './actors.js';
import type { CrewContact } from './crew-contact.js';

/** Bot-to-Bot hand-offs allowed under one root before the work must be escalated. */
export const CREW_DISPATCH_BUDGET = 8;

/**
 * Built only by Collaboration from an open piece of crew work. It is never parsed from a request:
 * it lets that work's assignee reach the people the work answers to, for messages only.
 */
export interface CrewPass { allows(target: string, action: string): boolean }

export interface CrewWorkPerson { actorId: string; displayName: string; kind: 'human' | 'session' }
export interface CrewWorkView {
  id: string; state: 'open' | 'closed'; origin: 'member' | 'bot' | 'routine';
  assigneeId: string; requesterId: string; parentId: string | null; rootId: string; messageId: string | null;
  /** Who this work answers to, nearest first; members who left the space are skipped; the owner is last. */
  chain: CrewWorkPerson[];
  budget: { used: number; limit: number };
  /** The dispatch message text; shown only to the assignee and the requester, null for routine work. */
  request: string | null;
  /** Work handed on from this one that is still open; the assignee should not finish before it settles. */
  openChildren: number;
  assignee: CrewWorkPerson;
  /** A file sent with the dispatch, shown to the assignee and the requester only. */
  attachment: { name: string; type: string; size: number } | null;
}
/** A message that reached a Bot inside crew work, filed against the Bot's own work. */
export interface CrewReply {
  seq: number; messageId: string; workId: string; requesterId: string; state: 'open' | 'closed';
  /** The work the reply was written under; answering down the tree goes back on it. */
  fromWorkId: string; from: CrewWorkPerson; content: string;
}
/** One row of a person's crew Inbox: the work as they may see it, and whether it is waiting on them. */
export interface CrewInboxItem {
  work: CrewWorkView;
  /** The latest message on this work that asked the caller something, unanswered since. */
  waiting: { from: CrewWorkPerson; content: string; at: number } | null;
  updatedAt: number;
}
const RECENT_MS = 7 * 86_400_000;
/** Who a crew message may go to, and which of the recipient's works it answers, if the recipient is a Bot. */
export interface CrewRoute { pass: CrewPass; recipientWorkId: string | null }

type Row = Record<string, unknown>;
const fail = (status: number, code: string): never => { throw Object.assign(Error(code), { status, code }); };
const id = (value: unknown): string => typeof value === 'string' && value && value.length <= 256 ? value : fail(400, 'invalid_input');

/**
 * The crew work ledger. Collaboration is its only writer and calls it inside the communication
 * transaction, so a message and the work it opens commit or roll back together. Completion of the
 * work itself is reported by the assignee's runtime through `finish`; the core does not guess it.
 */
export class CrewWork {
  constructor(private readonly db: DatabaseSync, private readonly actors: ActorStore,
    private readonly crew: CrewContact, private readonly now: () => number) {}

  #row(workId: unknown): Row {
    return this.db.prepare('SELECT * FROM crew_work WHERE id=?').get(id(workId)) ?? fail(404, 'crew_work_not_found');
  }
  #member(spaceId: unknown, actorId: unknown): boolean {
    return !!this.db.prepare('SELECT 1 FROM collaboration_space_members WHERE space_id=? AND actor_id=?').get(String(spaceId), String(actorId))
      && !!this.actors.get(String(actorId))?.enabled;
  }
  #owner(spaceId: unknown): string | null {
    const row = this.db.prepare('SELECT owner_actor_id FROM collaboration_spaces WHERE id=?').get(String(spaceId));
    return row ? String(row.owner_actor_id) : null;
  }
  #attachment(messageId: string | null): CrewWorkView['attachment'] {
    const file = messageId === null ? undefined
      : this.db.prepare('SELECT name,mime,length(bytes) AS size FROM actor_channel_attachments WHERE message_id=?').get(messageId);
    return file ? { name: String(file.name), type: String(file.mime), size: Number(file.size) } : null;
  }

  /** The dispatch file of open work the caller holds, in 64 KiB chunks. */
  attachmentChunk(context: ActorContext, workId: unknown, offset: unknown) {
    const row = this.#held(context, workId);
    const at = offset ?? 0;
    if (!Number.isSafeInteger(at) || Number(at) < 0 || Number(at) > 8 * 1024 * 1024) fail(400, 'invalid_input');
    const file = row.message_id === null ? undefined
      : this.db.prepare('SELECT name,mime,length(bytes) AS size,substr(bytes,?,65536) AS bytes FROM actor_channel_attachments WHERE message_id=?').get(Number(at) + 1, String(row.message_id));
    if (!file) return null;
    if (Number(at) > Number(file.size)) fail(400, 'invalid_input');
    return { name: String(file.name), type: String(file.mime), size: Number(file.size),
      next: Number(at) + 65536 < Number(file.size) ? Number(at) + 65536 : null, base64: Buffer.from(file.bytes as Uint8Array).toString('base64') };
  }

  /** Open work the caller holds. A Bot removed from its space no longer holds anything. */
  #held(context: ActorContext, workId: unknown): Row {
    const row = this.#row(workId);
    if (row.state !== 'open' || row.assignee_id !== context.actorId || !this.#member(row.space_id, row.assignee_id)) fail(403, 'crew_work_denied');
    return row;
  }

  /** Requesters up the tree, nearest first, then the space owner; departed members are skipped. */
  chain(row: Row): string[] {
    const people: string[] = [], seen = new Set<string>();
    for (let current: Row | undefined = row; current && !seen.has(String(current.id));) {
      seen.add(String(current.id));
      if (current.origin !== 'routine') people.push(String(current.requester_id));
      current = current.parent_id === null ? undefined : this.db.prepare('SELECT * FROM crew_work WHERE id=?').get(String(current.parent_id));
    }
    const owner = this.#owner(row.space_id);
    if (owner) people.push(owner);
    return [...new Set(people)].filter(actorId => actorId !== row.assignee_id && this.#member(row.space_id, actorId));
  }

  /**
   * A message about open work. Its assignee may write up the chain; its requester may answer the
   * assignee. Either way it is a reply, never a new dispatch, so it spends no budget. When the
   * recipient is a Bot, the message is filed against the recipient's own work in this tree.
   */
  route(context: ActorContext, workId: unknown, target: string): CrewRoute {
    const row = this.#row(workId);
    const only = (actorId: string): CrewPass => ({ allows: (to, action) => action === 'message.send' && to === actorId });
    if (row.state === 'open' && row.assignee_id === context.actorId && this.#member(row.space_id, context.actorId)) {
      if (!this.chain(row).includes(target)) fail(403, 'crew_work_denied');
      // A person is asked about this very work; the Inbox shows it as waiting on them.
      if (this.actors.get(target)?.kind === 'human') return { pass: only(target), recipientWorkId: String(row.id) };
      let recipientWorkId: string | null = null;
      for (let current = row.parent_id === null ? undefined : this.db.prepare('SELECT * FROM crew_work WHERE id=?').get(String(row.parent_id)), hops = 0;
        current && hops < 64; current = current.parent_id === null ? undefined : this.db.prepare('SELECT * FROM crew_work WHERE id=?').get(String(current.parent_id)), hops++) {
        if (current.assignee_id === target) { recipientWorkId = current.state === 'open' ? String(current.id) : null; break; }
      }
      return { pass: only(target), recipientWorkId };
    }
    if (row.state === 'open' && row.requester_id === context.actorId && row.assignee_id === target
      && this.#member(row.space_id, context.actorId) && this.#member(row.space_id, target))
      return { pass: only(target), recipientWorkId: String(row.id) };
    return fail(403, 'crew_work_denied');
  }

  file(messageId: string, recipientId: string, workId: string, fromWorkId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO crew_messages(message_id,recipient_id,work_id,from_work_id,created_at) VALUES(?,?,?,?,?)')
      .run(messageId, recipientId, workId, fromWorkId, this.now());
  }

  /** Replies filed for the calling Bot, oldest first. */
  replies(context: ActorContext, after: unknown): CrewReply[] {
    if (!Number.isSafeInteger(after) || Number(after) < 0) fail(400, 'invalid_input');
    return this.db.prepare(`SELECT c.seq,c.message_id,c.work_id,c.from_work_id,w.requester_id,w.state,m.author_id,m.content FROM crew_messages c
      JOIN crew_work w ON w.id=c.work_id JOIN actor_messages m ON m.id=c.message_id
      WHERE c.recipient_id=? AND c.seq>? ORDER BY c.seq LIMIT 50`).all(context.actorId, Number(after)).map(r => {
      const author = this.actors.get(String(r.author_id));
      return { seq: Number(r.seq), messageId: String(r.message_id), workId: String(r.work_id), requesterId: String(r.requester_id),
        state: r.state as CrewReply['state'], fromWorkId: String(r.from_work_id), content: String(r.content),
        from: { actorId: String(r.author_id), displayName: author?.displayName ?? '', kind: author?.kind === 'human' ? 'human' as const : 'session' as const } };
    });
  }

  /**
   * A person's crew Inbox: work they handed over, work that asked them something, and for a space
   * owner all work in that space. Open work and work closed in the last week, most recent first.
   */
  inbox(context: ActorContext): CrewInboxItem[] {
    const me = this.actors.get(context.actorId);
    if (!me || me.kind !== 'human') return fail(403, 'crew_work_denied');
    const since = this.now() - RECENT_MS;
    const rows = this.db.prepare(`SELECT DISTINCT w.id FROM crew_work w
      JOIN collaboration_space_members m ON m.space_id=w.space_id AND m.actor_id=?
      LEFT JOIN collaboration_spaces s ON s.id=w.space_id
      WHERE (w.state='open' OR w.closed_at>=?) AND (w.requester_id=? OR s.owner_actor_id=?
        OR EXISTS(SELECT 1 FROM crew_messages c WHERE c.work_id=w.id AND c.recipient_id=?))
      ORDER BY COALESCE(w.closed_at,w.created_at) DESC LIMIT 100`).all(me.id, since, me.id, me.id, me.id);
    return rows.flatMap(({ id }) => {
      let work: CrewWorkView;
      try { work = this.view(context, id); } catch { return []; }
      const asked = this.db.prepare(`SELECT m.author_id,m.content,m.created_at FROM crew_messages c JOIN actor_messages m ON m.id=c.message_id
        WHERE c.work_id=? AND c.recipient_id=? ORDER BY c.seq DESC LIMIT 1`).get(String(id), me.id);
      const answered = asked && this.db.prepare('SELECT 1 FROM actor_messages WHERE author_id=? AND target_id=? AND created_at>=? LIMIT 1')
        .get(me.id, String(asked.author_id), Number(asked.created_at));
      const author = asked && this.actors.get(String(asked.author_id));
      const waiting = work.state === 'open' && asked && !answered && author
        ? { from: { actorId: author.id, displayName: author.displayName, kind: author.kind === 'human' ? 'human' as const : 'session' as const },
          content: String(asked.content), at: Number(asked.created_at) } : null;
      const row = this.#row(id);
      return [{ work, waiting, updatedAt: Math.max(Number(row.closed_at ?? 0), Number(row.created_at), waiting?.at ?? 0) }];
    }).sort((a, b) => Number(!!b.waiting) - Number(!!a.waiting) || b.updatedAt - a.updatedAt);
  }

  /**
   * Who may look at a Bot's desk, and what the Core knows of it: any member of the Bot's space.
   * Runs in the storage owner; the caller then asks the Host for the live session.
   */
  deskAuthority(context: ActorContext, actorId: unknown) {
    const bot = id(actorId), space = this.crew.botSpace(bot);
    if (space === null || !this.#member(space, context.actorId)) return fail(403, 'crew_work_denied');
    const row = this.db.prepare("SELECT bot_id,epoch,environment_json,model_selection FROM personal_assistants WHERE actor_id=? AND state='claimed' AND paused=0").get(bot);
    if (!row) return fail(409, 'crew_desk_unavailable');
    const model = row.model_selection ? JSON.parse(String(row.model_selection)) as { providerId: string; modelId: string } : null;
    const members = this.db.prepare(`SELECT a.id AS actorId,a.display_name AS displayName,a.kind FROM collaboration_space_members m
      JOIN actors a ON a.id=m.actor_id WHERE m.space_id=?`).all(space).map(r => ({ actorId: String(r.actorId), displayName: String(r.displayName),
      kind: r.kind === 'human' ? 'human' as const : 'session' as const }));
    return { botId: String(row.bot_id), epoch: String(row.epoch), environment: JSON.parse(String(row.environment_json ?? '{"kind":"local"}')),
      model: model ? { providerId: model.providerId, modelId: model.modelId } : null,
      contacts: this.crew.phonebook(context, bot).length, members };
  }

  /**
   * Rule: every message a member sends to a space Bot is a dispatch. A Bot's own owner keeps their
   * private line to it, and Bots hand work on only through dispatch or reply under work they hold.
   */
  openForDirect(context: ActorContext, target: string, messageId: string): void {
    const space = this.crew.botSpace(target), sender = this.actors.get(context.actorId);
    if (space === null || sender?.kind !== 'human' || !this.#member(space, sender.id)) return;
    const owned = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='personal_assistants'").get()
      && this.db.prepare("SELECT 1 FROM personal_assistants WHERE actor_id=? AND owner_human_id=? AND state='claimed'").get(target, sender.id);
    if (!owned && !this.forMessage(messageId)) this.open(context, target, messageId);
  }

  /** Opens work for a message just sent to a space Bot. Bot hand-offs spend the root's budget. */
  open(context: ActorContext, assigneeId: string, messageId: string, parentWorkId?: unknown): string {
    const space = this.crew.botSpace(assigneeId) ?? fail(400, 'crew_assignee_not_bot');
    const sender = this.actors.get(context.actorId) ?? fail(401, 'actor_authentication_required');
    const parent = parentWorkId === undefined ? null : this.#held(context, parentWorkId);
    if (parent && parent.space_id !== space) fail(403, 'crew_work_denied');
    if (sender.kind === 'human' ? !this.#member(space, sender.id) : !parent) fail(sender.kind === 'human' ? 403 : 400, sender.kind === 'human' ? 'crew_work_denied' : 'crew_parent_required');
    const workId = randomUUID(), rootId = parent ? String(parent.root_id) : workId;
    if (parent) {
      const used = Number(this.#row(rootId).dispatches);
      if (used >= CREW_DISPATCH_BUDGET) fail(409, 'crew_budget_exhausted');
      this.db.prepare('UPDATE crew_work SET dispatches=dispatches+1 WHERE id=?').run(rootId);
    }
    this.db.prepare(`INSERT INTO crew_work(id,space_id,assignee_id,requester_id,parent_id,root_id,origin,message_id,state,dispatches,created_at,closed_at)
      VALUES(?,?,?,?,?,?,?,?,'open',0,?,NULL)`).run(workId, space, assigneeId, sender.id, parent ? String(parent.id) : null, rootId,
      sender.kind === 'human' ? 'member' : 'bot', messageId, this.now());
    return workId;
  }

  /** Work a Bot starts on its own. Nobody handed it over, so it answers to the space owner. */
  start(context: ActorContext): CrewWorkView {
    const space = this.crew.botSpace(context.actorId) ?? fail(403, 'crew_work_denied');
    const workId = randomUUID();
    this.db.prepare(`INSERT INTO crew_work(id,space_id,assignee_id,requester_id,parent_id,root_id,origin,message_id,state,dispatches,created_at,closed_at)
      VALUES(?,?,?,?,NULL,?,'routine',NULL,'open',0,?,NULL)`).run(workId, space, context.actorId, context.actorId, workId, this.now());
    return this.view(context, workId);
  }

  finish(context: ActorContext, workId: unknown): CrewWorkView {
    const row = this.#held(context, workId);
    this.db.prepare("UPDATE crew_work SET state='closed',closed_at=? WHERE id=?").run(this.now(), String(row.id));
    return this.view(context, String(row.id));
  }

  forMessage(messageId: string): string | null {
    const row = this.db.prepare('SELECT id FROM crew_work WHERE message_id=?').get(messageId);
    return row ? String(row.id) : null;
  }

  /** Readable by its assignee, its requester and everyone it answers to. */
  view(context: ActorContext, workId: unknown): CrewWorkView {
    const row = this.#row(workId), chain = this.chain(row);
    if (![row.assignee_id, row.requester_id, ...chain].includes(context.actorId)) fail(403, 'crew_work_denied');
    const person = (actorId: string): CrewWorkPerson => {
      const actor = this.actors.get(actorId)!;
      return { actorId, displayName: actor.displayName, kind: actor.kind === 'human' ? 'human' : 'session' };
    };
    const root = this.#row(row.root_id);
    const message = row.message_id === null || ![row.assignee_id, row.requester_id].includes(context.actorId) ? undefined
      : this.db.prepare('SELECT content FROM actor_messages WHERE id=?').get(String(row.message_id));
    return { id: String(row.id), state: row.state as CrewWorkView['state'], origin: row.origin as CrewWorkView['origin'],
      assigneeId: String(row.assignee_id), requesterId: String(row.requester_id), parentId: row.parent_id === null ? null : String(row.parent_id),
      rootId: String(row.root_id), messageId: row.message_id === null ? null : String(row.message_id),
      chain: chain.map(person), budget: { used: Number(root.dispatches), limit: CREW_DISPATCH_BUDGET },
      request: message ? String(message.content) : null,
      assignee: person(String(row.assignee_id)),
      attachment: this.#attachment(message ? String(row.message_id) : null),
      openChildren: Number(this.db.prepare("SELECT COUNT(*) AS n FROM crew_work WHERE parent_id=? AND state='open'").get(String(row.id))!.n) };
  }

  /** The caller's open work, oldest first. */
  list(context: ActorContext): CrewWorkView[] {
    return this.db.prepare("SELECT id FROM crew_work WHERE assignee_id=? AND state='open' ORDER BY created_at,id").all(context.actorId)
      .filter(row => this.#member(this.#row(row.id).space_id, context.actorId)).map(row => this.view(context, row.id));
  }
}
