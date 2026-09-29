import type { AsyncQuestion } from "@opencraft/chat-core";
import * as React from "react";

import { AsyncQuestionContext } from "../conversation-renderers/render-contexts";

export function AsyncQuestionCard({ question }: { readonly question: AsyncQuestion }) {
  const context = React.useContext(AsyncQuestionContext);
  const state = context.states.get(question.id) ?? "pending";
  const queued = context.queuedIds.has(question.id);
  const submitting = context.submittingIds.has(question.id);
  const draft = context.drafts[question.id] ?? {
    selectedIndex: question.options.length > 0 ? 0 : null,
    otherText: "",
  };
  const selected = draft.selectedIndex === null ? draft.otherText.trim() : question.options[draft.selectedIndex]?.trim() ?? "";
  const canAnswer = state === "pending" && !queued && !submitting && context.answer !== null;
  const status = state === "answered" ? "Answered"
    : state === "dismissed" ? "Superseded by a later message"
      : state === "unconfirmed" ? "Delivery unconfirmed"
        : state === "sending" || submitting ? "Sending answer…"
          : queued ? "Answer in follow-up queue" : context.answer === null ? "Connect to answer" : null;
  return (
    <section className="thread-async-question" data-state={status === null ? "pending" : state}>
      <fieldset disabled={!canAnswer}>
        <legend>{question.title}</legend>
        {state === "pending" && !queued ? (
          <>
            {question.options.length > 0 ? (
              <div className="thread-async-question__options" role="group" aria-label="Suggested answers">
                {question.options.map((option, index) => (
                  <label key={`${index}:${option}`}>
                    <input
                      checked={draft.selectedIndex === index}
                      name={`async-question:${question.id}`}
                      onChange={() => context.updateDraft(question.id, { ...draft, selectedIndex: index })}
                      type="radio"
                    />
                    <span>{option}</span>
                  </label>
                ))}
                <label>
                  <input
                    checked={draft.selectedIndex === null}
                    name={`async-question:${question.id}`}
                    onChange={() => context.updateDraft(question.id, { ...draft, selectedIndex: null })}
                    type="radio"
                  />
                  <span>Other</span>
                </label>
              </div>
            ) : null}
            {draft.selectedIndex === null ? (
              <textarea
                aria-label={`Answer: ${question.title}`}
                onChange={(event) => context.updateDraft(question.id, { selectedIndex: null, otherText: event.target.value })}
                placeholder="Type your answer"
                rows={2}
                value={draft.otherText}
              />
            ) : null}
            <div className="thread-async-question__footer">
              <button
                className="thread-async-question__send"
                disabled={!canAnswer || selected.length === 0}
                onClick={() => { if (context.answer !== null) void context.answer(question, selected); }}
                type="button"
              >Send answer</button>
              {context.errors[question.id] ? <span role="alert">{context.errors[question.id]}</span> : null}
            </div>
          </>
        ) : null}
        {status !== null ? <p className="thread-async-question__status" role="status">{status}</p> : null}
      </fieldset>
    </section>
  );
}
