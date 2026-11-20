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
 * - Work is reported finished only once it is quiet here: its intake turn settled, no Work linked
 *   to the conversation still active, and nothing waiting in the outbox for that conversation.
 * - Work whose dispatcher left before intake is not started; it is closed without a reply.
 */
const UPSERT = "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value";
const ACTIVE_WORK = ["queued", "running", "waiting_input", "awaiting_review", "awaiting_delivery"];
const peerKey = (actorId) => "crew:peer:" + actorId;
const conversationKey = (conversationId) => "crew:conversation:" + conversationId;
const inputId = (workId) => "crew:" + workId;

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
    const turn = db().prepare("SELECT status FROM reception WHERE id=?").get(inputId(work.id));
    if (!turn || turn.status !== "settled") return false;
    const marks = ACTIVE_WORK.map(() => "?").join(",");
    if (db().prepare(`SELECT 1 FROM work w JOIN conversation_work c ON c.work_id=w.id WHERE c.conversation_id=? AND w.status IN (${marks}) LIMIT 1`)
      .get(conversationId, ...ACTIVE_WORK)) return false;
    return !db().prepare("SELECT 1 FROM user_message WHERE conversation_id=? AND state='pending' LIMIT 1").get(conversationId);
  }

  const answersTo = (work) => work.chain.some((p) => p.actorId === work.requesterId);
  const isPeerConversation = (conversationId) => !!meta(conversationKey(conversationId));

  return {
    isPeerConversation,

    /** One pass over the Bot's open work: start new work, close work that has gone quiet. */
    async poll(stopped) {
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
          const response = await runner.dispatch({
            op: "say",
            id: inputId(work.id),
            params: { conversationId, text: `${from}:\n${work.request}` },
          });
          if (response?.ok === false) throw Error("Crew intake rejected");
          continue;
        }
        const conversationId = meta(peerKey(work.requesterId));
        if (conversationId && quiet(work, conversationId)) await request("opencraft/crew/work/finish", { workId: work.id });
      }
    },

    /**
     * Sends a reply from a dispatcher's conversation. It travels on the oldest open work from that
     * dispatcher, to the nearest person that work still answers to.
     */
    async deliver(message, text, signal) {
      const actorId = meta(conversationKey(message.conversationId));
      const { works } = await request("opencraft/crew/work/list", {}, signal);
      const work = works.find((w) => w.requesterId === actorId && w.chain.length);
      if (!work) throw Error("No open crew work for this conversation");
      return request("opencraft/crew/work/message",
        { workId: work.id, targetActorId: work.chain[0].actorId, content: text, idempotencyKey: message.id }, signal);
    },
  };
}
