import type { ActorInboxItem, ActorInboxPage } from '@opencraft/appserver-protocol/collaboration';

export interface ActorInboxTransport {
  /** Bound to one authenticated Server. Never send actorId as client authority. */
  sync(cursor: string | undefined, signal: AbortSignal): Promise<unknown>;
}
export function createActorInboxHttpTransport(request: (path: string, init: RequestInit) => Promise<Response>): ActorInboxTransport {
  return { async sync(cursor, signal) {
    const query = cursor === undefined ? '' : '?cursor=' + encodeURIComponent(cursor);
    const response = await request('/__opencraft_actors/collaboration/inbox/sync' + query, { signal, cache: 'no-store' });
    if (!response.ok) throw Object.assign(new Error('Inbox synchronization failed'), { status: response.status });
    return response.json();
  } };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Inbox response');
  return value as Record<string, unknown>;
}
function parsePage(value: unknown, actorId: string): ActorInboxPage {
  const page = object(value);
  if (page.actorId !== actorId || typeof page.reset !== 'boolean' || typeof page.hasMore !== 'boolean'
    || typeof page.cursor !== 'string' || !page.cursor || !Array.isArray(page.changes) || page.changes.length > 100) throw new Error('Invalid Inbox response');
  const changes = page.changes.map(value => {
    const row = object(value);
    if (typeof row.channelId !== 'string' || !row.channelId || typeof row.revision !== 'string' || !/^[1-9][0-9]*$/.test(row.revision)) throw new Error('Invalid Inbox change');
    let item: ActorInboxItem | null = null;
    if (row.item !== null) {
      const source = object(row.item);
      if (source.channelId !== row.channelId || !Number.isSafeInteger(source.unreadCount) || Number(source.unreadCount)<0) throw new Error('Invalid Inbox item');
      let message: ActorInboxItem['latestMessage']=null;
      if(source.latestMessage!==null){
        const latest=object(source.latestMessage);
        if(typeof latest.id!=='string'||typeof latest.sequence!=='string'||!/^[0-9]+$/.test(latest.sequence)
          ||typeof latest.authorId!=='string'||typeof latest.text!=='string'||typeof latest.at!=='number'||!Number.isFinite(latest.at))throw new Error('Invalid Inbox item');
        message={id:latest.id,sequence:latest.sequence,authorId:latest.authorId,text:latest.text,at:latest.at};
      }
      if(source.kind==='direct'&&typeof source.peerActorId==='string'){
        item={channelId:row.channelId,kind:'direct',peerActorId:source.peerActorId,unreadCount:Number(source.unreadCount),latestMessage:message};
      }else if(source.kind==='group'&&typeof source.title==='string'){
        if(source.mentionUnreadCount!==undefined&&(!Number.isSafeInteger(source.mentionUnreadCount)||Number(source.mentionUnreadCount)<0))throw Error('Invalid Inbox mention count');
        if(source.firstUnreadMentionSequence!==undefined&&(!Number.isSafeInteger(source.firstUnreadMentionSequence)||Number(source.firstUnreadMentionSequence)<1))throw Error('Invalid Inbox mention destination');
        item={channelId:row.channelId,...(source.firstUnreadMentionSequence===undefined?{}:{firstUnreadMentionSequence:Number(source.firstUnreadMentionSequence)}),kind:'group',title:source.title,unreadCount:Number(source.unreadCount),...(source.mentionUnreadCount===undefined?{}:{mentionUnreadCount:Number(source.mentionUnreadCount)}),latestMessage:message};
      }else throw new Error('Invalid Inbox item');
    }
    return { channelId: row.channelId, revision: row.revision, item };
  });
  return { actorId, reset: page.reset, hasMore: page.hasMore, cursor: page.cursor, changes };
}
/** One replica per authenticated Server + Actor lifetime. View mounting does not
 * own it. The application decides when to refresh (connect, foreground, hint).
 * No implicit background polling, execution, or credential persistence. */
export class ActorInboxClient {
  private readonly lifetime = new AbortController();
  private readonly rows = new Map<string, { revision: bigint; item: ActorInboxItem | null }>();
  private cursor?: string;
  private pending?: Promise<void>;
  private dirty = false;
  constructor(readonly actorId: string, private readonly transport: ActorInboxTransport) {}
  get items(): readonly ActorInboxItem[] {
    return [...this.rows.values()].flatMap(row => row.item ? [structuredClone(row.item)] : [])
      .sort((a, b) => (b.latestMessage?.at ?? 0) - (a.latestMessage?.at ?? 0) || a.channelId.localeCompare(b.channelId));
  }
  refresh(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('Inbox replica is closed'));
    this.dirty = true;
    if (this.pending) return this.pending;
    this.pending = this.pull().catch(error => {
      if (error?.status === 401 || error?.status === 403) this.close();
      throw error;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async pull(): Promise<void> {
    do {
      this.dirty = false;
      let more: boolean;
      do {
        const previous = this.cursor;
        const raw = await this.transport.sync(previous, this.lifetime.signal);
        if (this.lifetime.signal.aborted) throw new Error('Inbox replica is closed');
        const page = parsePage(raw, this.actorId);
        if (page.hasMore && page.cursor === previous) throw new Error('Inbox cursor did not advance');
        if (page.reset) this.rows.clear();
        for (const change of page.changes) {
          const revision = BigInt(change.revision), old = this.rows.get(change.channelId);
          if (!old || revision > old.revision) this.rows.set(change.channelId, { revision, item: change.item });
        }
        this.cursor = page.cursor;
        more = page.hasMore;
      } while (more);
    } while (this.dirty);
  }
  close(): void {
    this.lifetime.abort(); this.rows.clear(); this.cursor = undefined;
  }
}
