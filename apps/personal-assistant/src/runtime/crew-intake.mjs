import { downloadAttachment } from "./attachment-download.mjs";
/**
 * Crew work this Bot holds, joined to the runner's own conversations.
 *
 * The Core crew ledger owns each piece of work, who it answers to and whether it is still open.
 * The runner's application owns conversations, reception, Work and the outbox. The only local fact
 * written here is which conversation belongs to which dispatcher, kept in the runner's meta table
 * inside its UoW, so a restart resumes from durable state and never from an in-memory map.
 *
 * - Each dispatcher gets one conversation; every message they send counts as dispatch, so their
 *   follow-ups and answers to the Bot's questions arrive as new work in that same conversation.
 * - Replies in that conversation go back through the work's chain pass to the nearest person the
 *   work still answers to. A Bot asking upward is therefore the dispatcher's own decision to make.
 * - Replies are not dispatches. One that answers work this Bot holds is returned as a new turn in
 *   the conversation handling that work, so the Bot reads it with the work's context.
 * - Work is reported finished only once it is quiet here: its intake turn settled, nothing it
 *   handed on is still open, no Work linked to the conversation still active, nothing waiting in
 *   the outbox for that conversation, and no reply since its intake that failed to deliver.
 * - Work whose dispatcher left before intake is not started; it is closed without a reply. Work
 *   already started is stopped: its active Work in that conversation is cancelled, so the step in
 *   flight finishes without replay and no later step runs, and then the crew work is closed.
 */
const UPSERT = "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
const ACTIVE_WORK = ["queued", "running", "waiting_input", "awaiting_review", "awaiting_delivery"];
const peerKey = (actorId) => "crew:peer:" + actorId;
const conversationKey = (conversationId) => "crew:conversation:" + conversationId;
const inputId = (workId) => "crew:" + workId;
const REPLY_CURSOR = "crew:replies:seq";

export function createCrewIntake({ runner, request }) {
  const db = () => runner.uow.db;
  const meta = (key) => db().prepare("SELECT value FROM meta WHERE key=?").get(key)?.value;

  async function conversationFor(actorId) {
    const known = meta(peerKey(actorId));
    if (known) return known;
    const { conversationId } = await runner.dispatch({ op: "conversation.create", id: peerKey(actorId), params: {} });
    runner.uow.transaction(() => {
      db().prepare(UPSERT).run(peerKey(actorId), conversationId);
      db().prepare(UPSERT).run(conversationKey(conversationId), actorId);
    });
    return conversationId;
  }

  function quiet(work, conversationId) {
    if (work.openChildren !== 0) return false;
    const turn = db().prepare("SELECT status,created_at FROM reception WHERE id=?").get(inputId(work.id));
    if (!turn || turn.status !== "settled") return false;
    // A reply returned to this conversation is a turn of its own; wait for it as well.
    if (db().prepare("SELECT 1 FROM reception WHERE conversation_id=? AND status IN ('queued','running') LIMIT 1").get(conversationId)) return false;
    const marks = ACTIVE_WORK.map(() => "?").join(",");
    if (db().prepare(`SELECT 1 FROM work w JOIN conversation_work c ON c.work_id=w.id WHERE c.conversation_id=? AND w.status IN (${marks}) LIMIT 1`)
      .get(conversationId, ...ACTIVE_WORK)) return false;
    if (db().prepare("SELECT 1 FROM user_message WHERE conversation_id=? AND state='pending' LIMIT 1").get(conversationId)) return false;
    // A reply that could not be delivered leaves the work open, visibly stuck, instead of closing unanswered.
    return !db().prepare("SELECT 1 FROM user_message WHERE conversation_id=? AND state='failed' AND created_at>=? LIMIT 1").get(conversationId, turn.created_at);
  }

  const answersTo = (work) => work.chain.some((p) => p.actorId === work.requesterId);
  async function stop(conversationId, crewWorkId) {
    const marks = ACTIVE_WORK.map(() => "?").join(",");
    const active = db().prepare(`SELECT w.id,w.revision FROM work w JOIN conversation_work c ON c.work_id=w.id
      WHERE c.conversation_id=? AND w.status IN (${marks})`).all(conversationId, ...ACTIVE_WORK);
    for (const w of active) {
      const response = await runner.dispatch({ op: "cancel", id: `crew-stop:${crewWorkId}:${w.id}`, params: { workId: w.id, expectedRevision: w.revision } });
      if (response?.ok === false) throw Error("Crew stop rejected");
    }
  }
  const isPeerConversation = (conversationId) => !!meta(conversationKey(conversationId));

  /** The dispatcher whose conversation a runner Work belongs to, or null for any other Work. */
  const requesterOf = (workId) => {
    for (const { conversation_id } of db().prepare("SELECT conversation_id FROM conversation_work WHERE work_id=?").all(workId)) {
      const actorId = meta(conversationKey(conversation_id));
      if (actorId) return actorId;
    }
    return null;
  };

  return {
    isPeerConversation,
    /** Whether a runner Work answers crew work; only such Work gets the crew tools. */
    answers: (workId) => requesterOf(workId) !== null,
    /** The open crew work a runner Work answers: the oldest one from that dispatcher. */
    async held(workId, signal) {
      const actorId = requesterOf(workId);
      const { works } = await request("opencraft/crew/work/list", {}, signal);
      const work = actorId && works.find((w) => w.requesterId === actorId);
      if (!work) throw Error("This work no longer answers open crew work");
      return work;
    },

    /** One pass: return replies to their conversations, start new work, close work that has gone quiet. */
    async poll(stopped) {
      const after = Number(meta(REPLY_CURSOR) ?? 0);
      const { replies } = await request("opencraft/crew/work/replies", { after });
      for (const reply of replies) {
        if (stopped()) return;
        const conversationId = meta(peerKey(reply.requesterId));
        // A reply to work that already closed, or that this runner never took in, has no turn to join.
        if (reply.state === "open" && conversationId) {
          const response = await runner.dispatch({
            op: "say",
            id: "crew-reply:" + reply.messageId,
            // The hand-off it came from lets the Bot answer back down with crew_message.
            params: { conversationId, text: `${reply.from.displayName} (${reply.from.actorId}, work ${reply.fromWorkId}):\n${reply.content}` },
          });
          if (response?.ok === false) throw Error("Crew reply rejected");
        }
        runner.uow.transaction(() => db().prepare(UPSERT).run(REPLY_CURSOR, String(reply.seq)));
      }
      const { works } = await request("opencraft/crew/work/list", {});
      for (const work of works) {
        if (stopped()) return;
        const started = !!db().prepare("SELECT 1 FROM reception WHERE id=?").get(inputId(work.id));
        if (!started) {
          if (work.origin === "routine") continue;
          if (!answersTo(work) || typeof work.request !== "string" || !work.request.trim()) {
            await request("opencraft/crew/work/finish", { workId: work.id });
            continue;
          }
          const conversationId = await conversationFor(work.requesterId);
          const from = work.chain.find((p) => p.actorId === work.requesterId).displayName;
          const attachments = work.attachment
            ? [await downloadAttachment(runner.profile.path, async (offset) => (await request("opencraft/crew/work/attachment", { workId: work.id, offset })).file)]
            : undefined;
          const response = await runner.dispatch({
            op: "say",
            id: inputId(work.id),
            params: { conversationId, text: `${from}:\n${work.request}`, ...(attachments ? { attachments } : {}) },
          });
          if (response?.ok === false) throw Error("Crew intake rejected");
          continue;
        }
        const conversationId = meta(peerKey(work.requesterId));
        if (conversationId && !answersTo(work)) {
          // The dispatcher left after the work started: stop it. Cancelling lets the step in
          // flight finish without replay and refuses every later step.
          await stop(conversationId, work.id);
          await request("opencraft/crew/work/finish", { workId: work.id });
          continue;
        }
        if (conversationId && quiet(work, conversationId)) await request("opencraft/crew/work/finish", { workId: work.id });
      }
    },

    /**
     * Sends a reply from a dispatcher's conversation. It travels on the oldest open work from that
     * dispatcher, to the nearest person that work still answers to.
     */
    async deliver(message, text, signal) {
      const actorId = meta(conversationKey(message.conversation_id));
      const { works } = await request("opencraft/crew/work/list", {}, signal);
      const work = works.find((w) => w.requesterId === actorId && w.chain.length);
      if (!work) throw Error("No open crew work for this conversation");
      return request("opencraft/crew/work/message",
        { workId: work.id, targetActorId: work.chain[0].actorId, content: text, idempotencyKey: message.id }, signal);
    },
  };
}
