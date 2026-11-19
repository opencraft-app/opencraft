import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { LocalRunner } from "../../src/runtime/local-runner.mjs";
import { request } from "../../src/adapters/local/unix-socket.mjs";

/** Temporary test process/session ownership. No business writes bypass the socket. */
export function createScenarioContext({ profile, evidence, timeoutMs }) {
  let runner;
  const call = (op, params = {}, id = randomUUID()) => request(profile, { op, params, id });
  const wait = async (condition) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = await condition();
      if (value) return value;
      if (Date.now() > end) throw new Error("Scenario timed out");
      await delay(50);
    }
  };
  const open = async () => {
    runner = await LocalRunner.open(profile);
  };
  const close = async () => {
    if (runner) {
      await runner.close();
      runner = null;
    }
  };
  return {
    open,
    close,
    async capture() {
      if (!runner) return;
      evidence.history = await call("conversation");
      evidence.status = await call("status");
      evidence.events = await call("events");
      evidence.usage = await call("usage", { limit: 100 });
      evidence.observationBounds = {
        eventsMax: 1000,
        usageNext: evidence.usage.next,
      };
    },
    forScenario(id) {
      const scopedCall = (op, params, key) => call(op, params, key ? `${id}:${key}` : undefined);
      return {
        call: scopedCall,
        wait,
        profile,
        evidence,
        mode: evidence.mode,
        check(name, condition) {
          evidence.assertions[name] = !!condition;
          evidence.scenarios[id].assertions[name] = !!condition;
          assert.ok(condition, `${id}: ${name}`);
        },
        async say(text, key) {
          const inputId = `${id}:${key}`;
          evidence.transcript.push({ scenario: id, id: inputId, text });
          await call("say", { text }, inputId);
          return wait(async () => {
            const turn = await call("turn", { inputId });
            if (turn.status === "blocked") throw new Error(turn.reply_text);
            return turn.status === "settled" && turn;
          });
        },
        pending: (workId) =>
          wait(async () => {
            const detail = await call("work", { workId });
            if (detail.work.status === "blocked") throw new Error(detail.work.error);
            if (detail.work.status === "completed")
              throw new Error("Model completed without asking the explicitly requested question");
            return detail.work.status === "waiting_input" && detail.interactions.find((i) => i.state === "pending");
          }),
        done: (workId) =>
          wait(async () => {
            const detail = await call("work", { workId });
            if (detail.work.status === "blocked") throw new Error(detail.work.error);
            return detail.work.status === "completed" && detail;
          }),
        restart: async () => {
          await close();
          await open();
        },
        executionSessions: () => runner.work.executor.activeSessionCount(),
      };
    },
  };
}
