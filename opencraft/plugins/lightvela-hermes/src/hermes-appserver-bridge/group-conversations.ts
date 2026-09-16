import type {
  AppServerBotConversationDescriptor,
  AppServerBotDescriptor,
  AppServerBotExecution,
  AppServerBotInputPart,
  AppServerBotInteraction,
  AppServerBotMessage,
  AppServerBotParticipantSnapshot,
} from "@opencraft/appserver-protocol";

import type { HermesAppServerAdapter } from "./adapter";

type JsonRecord = Record<string, unknown>;

const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  (timer as unknown as { unref?: () => void }).unref?.();
};

export interface HermesHostedRoomMember {
  readonly member_id?: string;
  readonly profile?: string;
  readonly handle?: string;
  readonly display_name?: string;
  readonly target?: JsonRecord;
}

export interface HermesHostedRoom {
  readonly room_id: string;
  readonly name: string;
  readonly members: readonly HermesHostedRoomMember[];
  readonly authority_gateway_id: string;
  readonly authority_epoch: number;
  readonly revision: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly disbanded_at?: number | null;
  readonly latest_seq?: number;
  readonly idempotent?: boolean;
}

interface HermesHostedRoomEvent {
  readonly room_id: string;
  readonly seq: number;
  readonly event_id: string;
  readonly kind: string;
  readonly actor: { readonly kind?: string; readonly id?: string };
  readonly payload: JsonRecord;
  readonly created_at: number;
  readonly idempotent?: boolean;
}

interface HermesHostedRoomState {
  readonly room: HermesHostedRoom;
  readonly driver_status?: {
    readonly running?: boolean;
    readonly working?: boolean;
    readonly blocked?: boolean;
    readonly pending_actions?: readonly JsonRecord[];
  } | null;
}

interface HermesHostedRoomLog {
  readonly events: readonly HermesHostedRoomEvent[];
  readonly cursor: number;
  readonly latest_seq: number;
  readonly has_more: boolean;
  readonly authority: { readonly gateway_id: string; readonly epoch: number };
}

interface GroupCallbacks {
  readonly resolveBot: (botId: string) => Promise<AppServerBotDescriptor>;
  readonly botForProfile: (profile: string) => AppServerBotDescriptor;
  readonly profileForBotId: (botId: string) => string | null;
  readonly emit: (method: string, conversationId: string, payload: JsonRecord) => void;
}

const asRecord = (value: unknown): JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};

const secondsToMs = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1_000)
    : Date.now();

const HUMAN: AppServerBotParticipantSnapshot = Object.freeze({
  participantId: "person:you",
  kind: "human",
  displayName: "You",
  avatar: Object.freeze({ type: "generated", seed: "opencraft-human" }),
});

function participant(bot: AppServerBotDescriptor): AppServerBotParticipantSnapshot {
  return Object.freeze({
    participantId: `bot:${bot.botId}`,
    kind: "bot",
    displayName: bot.name,
    avatar: bot.avatar,
  });
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64);
}

export class HermesGroupConversations {
  private supported = false;
  private prepared = false;
  private disposed = false;
  private readonly rooms = new Map<string, HermesHostedRoom>();
  private readonly cursorByRoom = new Map<string, number>();
  private readonly polling = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingApprovals = new Map<string, {
    roomId: string; memberId: string; taskId: string; executionGeneration: number; requestId: string;
  }>();
  private readonly activeRooms = new Set<string>();

  constructor(
    private readonly adapter: HermesAppServerAdapter,
    private readonly callbacks: GroupCallbacks,
  ) {}

  get available(): boolean { return this.supported; }

  async prepareCapability(): Promise<boolean> {
    if (this.prepared) return this.supported;
    this.prepared = true;
    try {
      const capability = await this.adapter.callHostedRoom<{ driver?: boolean; methods?: string[] }>(
        "groups.capabilities",
        {},
      );
      const methods = new Set(Array.isArray(capability.methods) ? capability.methods : []);
      this.supported = capability.driver === true
        && ["groups.list", "groups.create", "groups.state", "groups.log", "groups.send", "groups.stop"]
          .every((method) => methods.has(method));
    } catch (error) {
      const value = asRecord(error);
      const code = error instanceof Error ? asRecord(error).code : value.code;
      if (code !== -32601 && !/method not (?:found|supported)/iu.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      this.supported = false;
    }
    return this.supported;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.polling.values()) clearTimeout(timer);
    this.polling.clear();
    this.activeRooms.clear();
    this.pendingApprovals.clear();
  }

  async list(botId?: string): Promise<AppServerBotConversationDescriptor[]> {
    if (!this.supported) return [];
    const result = await this.adapter.callHostedRoom<{ rooms?: HermesHostedRoom[] }>("groups.list", {
      include_disbanded: false,
      limit: 200,
      offset: 0,
    });
    const rooms = Array.isArray(result.rooms) ? result.rooms : [];
    const descriptors: AppServerBotConversationDescriptor[] = [];
    for (const room of rooms) {
      this.rooms.set(room.room_id, room);
      const descriptor = this.descriptor(room);
      if (botId === undefined || descriptor.participantIds.includes(`bot:${botId}`)) descriptors.push(descriptor);
    }
    return descriptors;
  }

  async owns(conversationId: string): Promise<boolean> {
    if (!this.supported) return false;
    if (this.rooms.has(conversationId)) return true;
    try {
      const state = await this.state(conversationId);
      return state.room.disbanded_at == null;
    } catch (error) {
      if (/room not found|not found/iu.test(error instanceof Error ? error.message : String(error))) return false;
      throw error;
    }
  }

  async create(value: JsonRecord): Promise<{ conversation: AppServerBotConversationDescriptor; replayed: boolean }> {
    const requestId = this.requiredString(value.clientRequestId, "clientRequestId");
    const participantIds = Array.isArray(value.participantIds) ? value.participantIds.map(String) : [];
    if (participantIds.length < 2 || participantIds.length > 6 || participantIds.some((id) => !id.startsWith("bot:"))) {
      throw Object.assign(new Error("A Hermes group requires 2 to 6 Bot participants"), { rpcCode: -32602 });
    }
    const bots = await Promise.all(participantIds.map((id) => this.callbacks.resolveBot(id.slice(4))));
    if (bots.some((bot) => bot.status !== "available")) throw new Error("Every group Bot must be available");
    const members = bots.map((bot) => {
      const profile = this.callbacks.profileForBotId(bot.botId);
      if (profile === null) throw new Error(`Bot profile not found: ${bot.botId}`);
      return {
        member_id: safeId(bot.botId) || profile,
        profile,
        handle: safeId(bot.name) || safeId(profile),
        display_name: bot.name,
        target: { kind: "local", profile },
      };
    });
    const roomId = `room_${safeId(requestId) || requestId.replace(/[^a-zA-Z0-9_-]/gu, "")}`.slice(0, 96);
    const result = await this.adapter.callHostedRoom<{ room: HermesHostedRoom }>("groups.create", {
      room_id: roomId,
      name: typeof value.title === "string" && value.title.trim() ? value.title.trim() : bots.map((bot) => bot.name).join(", "),
      members,
      profile: members[0]!.profile,
    });
    this.rooms.set(result.room.room_id, result.room);
    return { conversation: this.descriptor(result.room), replayed: result.room.idempotent === true };
  }

  async read(conversationId: string, limit = 100) {
    const [state, log] = await Promise.all([this.state(conversationId), this.log(conversationId, 0, limit)]);
    const participants = [HUMAN, ...state.room.members.map((member) => participant(this.botForMember(member)))];
    const messages = log.events.flatMap((event) => {
      const message = this.message(state.room, event);
      return message === null ? [] : [message];
    });
    this.cursorByRoom.set(conversationId, log.latest_seq);
    this.schedulePoll(conversationId);
    return {
      conversation: this.descriptor(state.room),
      participants,
      initialMessagesPage: { data: messages },
      executions: [...this.executions(state.room, log.events), ...this.activeRoomExecutions(state)],
      interactions: this.interactions(state.room, state),
      presence: [],
      liveCursor: { epoch: this.epoch(state.room), nextSeq: log.latest_seq + 1 },
    };
  }

  async messages(conversationId: string, cursor: string | undefined, limit: number) {
    const state = await this.state(conversationId);
    const since = cursor?.startsWith("hermes-group:") ? Number(cursor.slice("hermes-group:".length)) || 0 : 0;
    const log = await this.log(conversationId, since, limit);
    return {
      data: log.events.flatMap((event) => {
        const message = this.message(state.room, event);
        return message === null ? [] : [message];
      }),
      ...(log.has_more ? { nextCursor: `hermes-group:${log.cursor}` } : {}),
    };
  }

  async send(conversationId: string, clientMessageId: string, content: readonly unknown[], replyTo?: string) {
    const text = content.map((raw) => {
      const part = asRecord(raw) as AppServerBotInputPart;
      if (part.type === "text") return part.text;
      if (part.type === "mention") return `@${part.label}`;
      if (part.type === "resource") return `[${part.title}](${part.uri})`;
      return "";
    }).filter(Boolean).join("\n").trim();
    if (!text) throw Object.assign(new Error("A Hermes group message requires text"), { rpcCode: -32602 });
    const result = await this.adapter.callHostedRoom<{ event: HermesHostedRoomEvent; accepted?: boolean }>("groups.send", {
      room_id: conversationId,
      event_id: clientMessageId,
      payload: { text, thread_id: replyTo || clientMessageId },
    });
    const state = await this.state(conversationId);
    const room = state.room;
    const message = this.message(room, result.event)!;
    this.schedulePoll(conversationId, true);
    const bot = this.botForMember(room.members[0]!);
    const execution: AppServerBotExecution = {
      executionId: `group:${conversationId}:active`,
      conversationId,
      participantId: `bot:${bot.botId}`,
      causalMessageId: message.messageId,
      status: result.accepted === false ? "failed" : "queued",
      startedAtMs: Date.now(),
    };
    return { message, executions: [execution], replayed: result.event.idempotent === true };
  }

  async update(conversationId: string, expectedRevision: number, patch: JsonRecord) {
    const state = await this.state(conversationId);
    if (state.room.revision !== expectedRevision) throw new Error("Group revision conflict");
    if (typeof patch.title === "string" && patch.title.trim()) {
      const result = await this.adapter.callHostedRoom<{ room: HermesHostedRoom }>("groups.rename", {
        room_id: conversationId,
        event_id: crypto.randomUUID(),
        name: patch.title.trim(),
      });
      this.rooms.set(conversationId, result.room);
      return { conversation: this.descriptor(result.room) };
    }
    if (Array.isArray(patch.participantIds)) {
      throw Object.assign(new Error("Hermes hosted rooms have a frozen roster; recreate the group to change members"), {
        rpcCode: -32049,
        domainData: { code: "BOT_CAPABILITY_UNAVAILABLE", retryable: false },
      });
    }
    return { conversation: this.descriptor(state.room) };
  }

  async remove(conversationId: string) {
    const state = await this.state(conversationId);
    await this.adapter.callHostedRoom("groups.disband", { room_id: conversationId, cancel_id: crypto.randomUUID() });
    this.rooms.delete(conversationId);
    return { conversationId, revision: state.room.revision + 1 };
  }

  async cancel(conversationId: string, executionId: string, commandId: string) {
    const state = await this.state(conversationId);
    await this.adapter.callHostedRoom("groups.stop", { room_id: conversationId, cancel_id: commandId });
    const bot = this.botForMember(state.room.members[0]!);
    const execution: AppServerBotExecution = {
      executionId,
      conversationId,
      participantId: `bot:${bot.botId}`,
      causalMessageId: `causal:${executionId}`,
      status: "cancelled",
      completedAtMs: Date.now(),
    };
    return { execution, replayed: false };
  }

  async respond(conversationId: string, interactionId: string, choiceId: string) {
    const pending = this.pendingApprovals.get(interactionId);
    if (pending === undefined || pending.roomId !== conversationId) {
      throw Object.assign(new Error(`Interaction not found: ${interactionId}`), {
        rpcCode: -32044,
        domainData: { code: "BOT_INTERACTION_NOT_FOUND", retryable: false },
      });
    }
    await this.adapter.callHostedRoom("groups.approve", {
      room_id: conversationId,
      member_id: pending.memberId,
      task_id: pending.taskId,
      execution_generation: pending.executionGeneration,
      choice: choiceId,
      request_id: pending.requestId,
    });
    this.pendingApprovals.delete(interactionId);
    return {
      interaction: {
        interactionId,
        conversationId,
        executionId: pending.taskId,
        participantId: `bot:${this.botForMember(
          this.rooms.get(conversationId)?.members.find(member => member.member_id === pending.memberId)
            ?? { profile: "default" },
        ).botId}`,
        kind: "approval" as const,
        status: "resolved" as const,
        title: "Approval resolved",
        choices: [{ choiceId, label: choiceId }],
      },
      replayed: false,
    };
  }

  private async state(roomId: string): Promise<HermesHostedRoomState> {
    const state = await this.adapter.callHostedRoom<HermesHostedRoomState>("groups.state", {
      room_id: roomId,
      include_disbanded: false,
    });
    this.rooms.set(roomId, state.room);
    return state;
  }

  private log(roomId: string, sinceSeq: number, limit: number): Promise<HermesHostedRoomLog> {
    return this.adapter.callHostedRoom("groups.log", {
      room_id: roomId,
      since_seq: Math.max(0, sinceSeq),
      limit: Math.min(Math.max(limit, 1), 500),
      include_disbanded: false,
    });
  }

  private descriptor(room: HermesHostedRoom): AppServerBotConversationDescriptor {
    return {
      conversationId: room.room_id,
      revision: Math.max(1, room.revision),
      topology: "group",
      title: room.name,
      participantIds: ["person:you", ...room.members.map((member) => `bot:${this.botForMember(member).botId}`)],
      createdAtMs: secondsToMs(room.created_at),
      updatedAtMs: secondsToMs(room.updated_at),
    };
  }

  private botForMember(member: HermesHostedRoomMember): AppServerBotDescriptor {
    const profile = member.profile?.trim() || asRecord(member.target).profile;
    if (typeof profile !== "string" || !profile) throw new Error("Hermes room member has no profile identity");
    return this.callbacks.botForProfile(profile);
  }

  private message(room: HermesHostedRoom, event: HermesHostedRoomEvent): AppServerBotMessage | null {
    if (event.kind !== "message.user" && event.kind !== "message.member") return null;
    const text = typeof event.payload.text === "string" ? event.payload.text : "";
    const bot = event.kind === "message.member"
      ? this.botForMember(room.members.find((member) => member.member_id === event.payload.member_id)
        ?? { profile: String(event.actor.id || "default") })
      : null;
    const executionId = typeof event.payload.task_id === "string" ? event.payload.task_id : undefined;
    return {
      messageId: event.event_id,
      conversationId: room.room_id,
      ...(event.kind === "message.user" ? { clientMessageId: event.event_id } : {}),
      author: bot === null ? HUMAN : participant(bot),
      createdAtMs: secondsToMs(event.created_at),
      updatedAtMs: secondsToMs(event.created_at),
      state: "complete",
      content: [{ type: "text", text }],
      ...(bot === null ? {} : {
        causalMessageId: String(event.payload.discussion_event_id || `causal:${event.event_id}`),
        ...(executionId ? { executionId } : {}),
      }),
    };
  }

  private executions(room: HermesHostedRoom, events: readonly HermesHostedRoomEvent[]): AppServerBotExecution[] {
    return events.flatMap((event) => {
      if (!event.kind.startsWith("turn.")) return [];
      const taskId = typeof event.payload.task_id === "string" ? event.payload.task_id : null;
      const memberId = typeof event.payload.member_id === "string" ? event.payload.member_id : null;
      if (!taskId || !memberId) return [];
      const member = room.members.find((candidate) => candidate.member_id === memberId);
      if (!member) return [];
      const bot = this.botForMember(member);
      const status: AppServerBotExecution["status"] = event.kind === "turn.settled"
        ? "completed" : event.kind === "turn.failed" ? "failed" : event.kind === "turn.cancelled" ? "cancelled" : "queued";
      return [{
        executionId: taskId,
        conversationId: room.room_id,
        participantId: `bot:${bot.botId}`,
        causalMessageId: String(event.payload.discussion_event_id || `causal:${taskId}`),
        status,
        completedAtMs: secondsToMs(event.created_at),
      }];
    });
  }

  private activeRoomExecutions(state: HermesHostedRoomState): AppServerBotExecution[] {
    if (state.driver_status?.working !== true && state.driver_status?.blocked !== true) return [];
    const member = state.room.members[0];
    if (!member) return [];
    const bot = this.botForMember(member);
    return [{
      executionId: `group:${state.room.room_id}:active`,
      conversationId: state.room.room_id,
      participantId: `bot:${bot.botId}`,
      causalMessageId: `causal:${state.room.room_id}:active`,
      status: state.driver_status.blocked === true ? "queued" : "running",
      startedAtMs: Date.now(),
    }];
  }

  private interactions(room: HermesHostedRoom, state: HermesHostedRoomState): AppServerBotInteraction[] {
    return (state.driver_status?.pending_actions ?? []).flatMap((action) => {
      if (action.kind !== "approval") return [];
      const memberId = String(action.member_id || "");
      const member = room.members.find((candidate) => candidate.member_id === memberId);
      if (!member) return [];
      const bot = this.botForMember(member);
      const interactionId = String(action.request_id || `${action.task_id}:approval`);
      this.pendingApprovals.set(interactionId, {
        roomId: room.room_id,
        memberId,
        taskId: String(action.task_id || "unknown"),
        executionGeneration: Number(action.execution_generation || 0),
        requestId: String(action.request_id || interactionId),
      });
      return [{
        interactionId,
        conversationId: room.room_id,
        executionId: String(action.task_id || "unknown"),
        participantId: `bot:${bot.botId}`,
        kind: "approval" as const,
        status: "pending" as const,
        title: String(action.description || "Approval required"),
        choices: [{ choiceId: "once", label: "Allow once" }, { choiceId: "deny", label: "Deny", destructive: true }],
      }];
    });
  }

  private schedulePoll(roomId: string, immediate = false): void {
    if (this.disposed || this.polling.has(roomId)) return;
    const run = async () => {
      this.polling.delete(roomId);
      if (this.disposed) return;
      try {
        const since = this.cursorByRoom.get(roomId) ?? 0;
        const [state, log] = await Promise.all([this.state(roomId), this.log(roomId, since, 200)]);
        for (const event of log.events) {
          const message = this.message(state.room, event);
          if (message !== null && event.seq > since) {
            this.callbacks.emit("bot/message/completed", roomId, { message });
          }
          for (const execution of this.executions(state.room, [event])) {
            this.callbacks.emit("bot/execution/updated", roomId, { execution });
          }
        }
        this.cursorByRoom.set(roomId, Math.max(since, log.latest_seq));
        if (state.driver_status?.working === true || state.driver_status?.blocked === true) {
          this.activeRooms.add(roomId);
          for (const execution of this.activeRoomExecutions(state)) {
            this.callbacks.emit("bot/execution/updated", roomId, { execution });
          }
          const timer = setTimeout(run, 1_000);
          unrefTimer(timer);
          this.polling.set(roomId, timer);
        } else if (this.activeRooms.delete(roomId)) {
          const member = state.room.members[0];
          if (member) {
            const bot = this.botForMember(member);
            this.callbacks.emit("bot/execution/updated", roomId, { execution: {
              executionId: `group:${roomId}:active`,
              conversationId: roomId,
              participantId: `bot:${bot.botId}`,
              causalMessageId: `causal:${roomId}:active`,
              status: "completed",
              completedAtMs: Date.now(),
            } });
          }
        }
      } catch {
        // A View refresh re-establishes authority. Poll failure must not invent
        // terminal events or fork a second owner.
      }
    };
    const timer = setTimeout(run, immediate ? 0 : 1_000);
    unrefTimer(timer);
    this.polling.set(roomId, timer);
  }

  private epoch(room: HermesHostedRoom): string {
    return `${room.authority_gateway_id}:${room.authority_epoch}`;
  }

  private requiredString(value: unknown, name: string): string {
    if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error(`${name} must be a non-empty string`), { rpcCode: -32602 });
    return value.trim();
  }
}
