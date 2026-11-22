import type { DatabaseSync } from 'node:sqlite';
import type { ActorContext } from '@opencraft/identity-core/actors';
import type { ActorStore } from './actors.js';

/** A phonebook entry lets a Bot find someone and hand them work; both travel together. */
export const PHONEBOOK_ACTIONS = ['message.send', 'execution.queue'] as const;
export interface PhonebookEntry { actorId: string; displayName: string; kind: 'human' | 'session' }
/** What a member sees when opening a Bot's phonebook: its entries, who could be added, and whether they may edit. */
export interface PhonebookView { entries: PhonebookEntry[]; members: PhonebookEntry[]; editable: boolean }
export interface CrewTeamMember extends PhonebookEntry { role: 'owner' | 'member' }
/** A space as its members see it in the Inbox: who is in it, and whether the caller runs it. */
export interface CrewTeam { id: string; name: string; role: 'owner' | 'member'; openContact: boolean; members: CrewTeamMember[] }

const denied = (): never => { throw Object.assign(Error('channel_denied'), { status: 403, code: 'channel_denied' }); };
const invalid = (): never => { throw Object.assign(Error('invalid_input'), { status: 400, code: 'invalid_input' }); };

/**
 * Crew contact rules, read inside the caller's transaction from the shared Server schema.
 * Spaces keep ServerSpacesLedger as their writer and grants keep ActorStore; this only decides,
 * and phonebook edits go through ActorStore.setGrant.
 *
 * - A human may reach any member of a space they share whose contact is open.
 * - A Bot that belongs to a space may proactively reach only its phonebook: exact grants,
 *   and only members of its own space. Bots outside every space keep the existing grant rule.
 */
export class CrewContact {
  /** A standalone collaboration repository has no spaces; crew rules then stand aside entirely. */
  readonly #spaces: boolean;
  constructor(private readonly db: DatabaseSync, private readonly actors: ActorStore) {
    this.#spaces = !!db.prepare("SELECT 1 FROM pragma_table_info('collaboration_spaces') WHERE name='open_contact'").get()
      && !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collaboration_space_members'").get();
  }

  /** Whether this store has Server spaces at all; without them crew rules stand aside. */
  get hasSpaces(): boolean { return this.#spaces; }

  /** The one space a Bot belongs to, or null for a Bot outside every space. */
  botSpace(actorId: string): string | null {
    if (!this.#spaces) return null;
    const row = this.db.prepare(`SELECT m.space_id FROM collaboration_space_members m JOIN actors a ON a.id=m.actor_id
      WHERE m.actor_id=? AND a.kind='session'`).get(actorId);
    return row ? String(row.space_id) : null;
  }
  #role(spaceId: string, actorId: string): string | null {
    const row = this.db.prepare('SELECT role FROM collaboration_space_members WHERE space_id=? AND actor_id=?').get(spaceId, actorId);
    return row ? String(row.role) : null;
  }
  #sharesOpenSpace(a: string, b: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM collaboration_space_members x
      JOIN collaboration_space_members y ON y.space_id=x.space_id
      JOIN collaboration_spaces s ON s.id=x.space_id
      WHERE x.actor_id=? AND y.actor_id=? AND s.open_contact=1 LIMIT 1`).get(a, b);
  }

  /**
   * true: crew rules allow. false: crew rules deny (a space Bot reaching outside its phonebook).
   * null: crew rules do not apply; the caller keeps its existing grant policy.
   */
  decide(context: ActorContext, target: string, action: string): boolean | null {
    if (!this.#spaces || !(PHONEBOOK_ACTIONS as readonly string[]).includes(action) || context.actorId === target) return null;
    const sender = this.actors.get(context.actorId);
    if (!sender) return null;
    if (sender.kind === 'human') return this.#sharesOpenSpace(sender.id, target) ? true : null;
    const space = this.botSpace(sender.id);
    if (space === null) return null;
    return this.#role(space, target) !== null && this.actors.can(context, target, action);
  }

  /** Any member of the Bot's space may read its phonebook; it is part of how the team works. */
  phonebook(context: ActorContext, botId: unknown): PhonebookEntry[] {
    const space = this.#botFor(botId);
    if (!this.#role(space, context.actorId)) denied();
    return this.db.prepare(`SELECT a.id AS actorId,a.display_name AS displayName,a.kind FROM actor_grants g
      JOIN actors a ON a.id=g.resource
      JOIN collaboration_space_members m ON m.actor_id=a.id AND m.space_id=?
      WHERE g.actor_id=? AND g.action='message.send' AND g.enabled=1 AND a.enabled=1
      ORDER BY a.display_name,a.id`).all(space, String(botId)) as unknown as PhonebookEntry[];
  }

  view(context: ActorContext, botId: unknown): PhonebookView {
    const entries = this.phonebook(context, botId), space = this.#botFor(botId);
    const members = this.db.prepare(`SELECT a.id AS actorId,a.display_name AS displayName,a.kind FROM collaboration_space_members m
      JOIN actors a ON a.id=m.actor_id WHERE m.space_id=? AND m.actor_id<>? AND a.enabled=1 ORDER BY a.display_name,a.id`).all(space, String(botId)) as unknown as PhonebookEntry[];
    const operator = this.actors.get(context.actorId);
    return { entries, members, editable: operator?.kind === 'human' && this.#role(space, context.actorId) === 'owner' };
  }

  /** The spaces the caller belongs to, with their members; the instance-wide default space is left out. */
  teams(context: ActorContext): CrewTeam[] {
    if (!this.#spaces) return [];
    const spaces = this.db.prepare(`SELECT s.id,s.name,s.open_contact,m.role FROM collaboration_spaces s
      JOIN collaboration_space_members m ON m.space_id=s.id AND m.actor_id=?
      WHERE s.id<>'myself' ORDER BY s.created_at,s.id`).all(context.actorId);
    return spaces.map(space => ({
      id: String(space.id), name: String(space.name), role: space.role === 'owner' ? 'owner' as const : 'member' as const,
      openContact: Number(space.open_contact) === 1,
      members: this.db.prepare(`SELECT a.id AS actorId,a.display_name AS displayName,a.kind,m.role FROM collaboration_space_members m
        JOIN actors a ON a.id=m.actor_id WHERE m.space_id=? AND a.enabled=1 ORDER BY m.role='owner' DESC,a.kind='session',a.display_name,a.id`).all(String(space.id))
        .map(r => ({ actorId: String(r.actorId), displayName: String(r.displayName), kind: r.kind === 'human' ? 'human' as const : 'session' as const,
          role: r.role === 'owner' ? 'owner' as const : 'member' as const })),
    }));
  }

  /** Only the space owner edits a Bot's phonebook, and only with members of that space. */
  setPhonebook(context: ActorContext, botId: unknown, actorId: unknown, present: unknown): PhonebookEntry[] {
    const space = this.#botFor(botId);
    const operator = this.actors.get(context.actorId);
    if (operator?.kind !== 'human' || this.#role(space, context.actorId) !== 'owner') denied();
    if (typeof actorId !== 'string' || typeof present !== 'boolean' || actorId === botId) invalid();
    if (present && !this.#role(space, actorId as string)) invalid();
    for (const action of PHONEBOOK_ACTIONS) this.actors.setGrant(String(botId), actorId as string, action, present as boolean, context.actorId);
    return this.phonebook(context, botId);
  }

  #botFor(botId: unknown): string {
    if (typeof botId !== 'string' || !botId || botId.length > 256) invalid();
    const space = this.botSpace(botId as string);
    if (space === null) denied();
    return space as string;
  }
}
