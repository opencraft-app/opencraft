import type { AsyncQuestion } from "@opencraft/chat-core";
import { useIntl } from "@opencraft/i18n/react";
import { ArrowRightIcon as ArrowRight, CheckIcon as Check, ChevronDownIcon as ChevronDown } from "@opencraft/design-system-web/action-icons";
import * as React from "react";

import { useOptionalAsyncNotices } from "../async-notices-context";
import { AsyncQuestionContext } from "../conversation-renderers/render-contexts";
import { Button } from "../ui/button";

export function AsyncQuestionCard({ question, title }: { readonly question: AsyncQuestion; readonly title: React.ReactNode }) {
  const context = React.useContext(AsyncQuestionContext);
  const intl = useIntl();
  const notices = useOptionalAsyncNotices();
  const titleId = React.useId();
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const state = context.states.get(question.id) ?? "pending";
  const queued = context.queuedIds.has(question.id);
  const submitting = context.submittingIds.has(question.id);
  const draft = context.drafts[question.id] ?? {
    selectedIndex: question.options.length > 0 ? 0 : null,
    otherText: "",
  };
  const selected = draft.selectedIndex === null ? draft.otherText.trim() : question.options[draft.selectedIndex]?.trim() ?? "";
  const canAnswer = state === "pending" && !queued && !submitting && context.answer !== null;
  const submitAnswer = () => {
    if (canAnswer && selected.length > 0 && context.answer !== null) void context.answer(question, selected);
  };
  const error = context.errors[question.id];
  const failure = intl.formatMessage({ id: "chat.question.failure", defaultMessage: "Answer not sent. Your selection is saved; please retry." });
  React.useEffect(() => {
    if (error) notices?.error({ key: `question:${question.id}`, message: failure });
  }, [error, failure, notices, question.id]);
  const sending = state === "sending" || submitting;
  const status = state === "answered" ? intl.formatMessage({ id: "chat.question.answered", defaultMessage: "Answered" })
    : state === "unconfirmed" ? intl.formatMessage({ id: "chat.question.unconfirmed", defaultMessage: "Delivery unconfirmed" })
        : sending ? intl.formatMessage({ id: "chat.question.sending", defaultMessage: "Sending answer…" })
          : queued ? intl.formatMessage({ id: "chat.question.queued", defaultMessage: "Answer in follow-up queue" })
            : context.answer === null ? intl.formatMessage({ id: "chat.question.offline", defaultMessage: "Connect to answer" }) : null;
  const resolved = state === "answered";
  const answer = context.answers.get(question.id);
  const viewQuestion = intl.formatMessage({ id: "chat.question.view", defaultMessage: "View question" });
  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    const fit = () => {
      input.style.height = "0px";
      input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
    };
    fit();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      fit();
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [draft.otherText, draft.selectedIndex, canAnswer, state, queued, question.id]);
  if (state === "dismissed") return <>{title}</>;
  return (
    <section className="thread-async-question" data-state={state !== "pending" ? state : queued ? "queued" : sending ? "sending" : state}>
      {resolved ? (
        <details className="thread-async-question__result">
          <summary>
            {state === "answered" ? <Check aria-hidden="true" /> : null}
            <span className="thread-async-question__status">{status}</span>
            {state === "answered" && answer !== undefined ? <span className="thread-async-question__answer">{answer}</span> : null}
            <span className="thread-async-question__disclosure">{viewQuestion}<ChevronDown aria-hidden="true" /></span>
          </summary>
          <div className="thread-async-question__title">{title}</div>
        </details>
      ) : (
        <fieldset aria-labelledby={titleId} disabled={!canAnswer}>
          <div className="thread-async-question__title" id={titleId}>{title}</div>
          {state === "pending" && !queued ? (
            <>
              {question.options.length > 0 ? (
                <div className="thread-async-question__options" role="radiogroup" aria-labelledby={titleId}>
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
                    <span>{intl.formatMessage({ id: "chat.question.other", defaultMessage: "Custom answer" })}</span>
                  </label>
                </div>
              ) : null}
              {draft.selectedIndex === null ? (
                <textarea
                  ref={inputRef}
                  aria-label={intl.formatMessage({ id: "chat.question.answer", defaultMessage: "Your answer" })}
                  onChange={(event) => context.updateDraft(question.id, { selectedIndex: null, otherText: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.altKey
                      || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (!event.repeat) submitAnswer();
                  }}
                  placeholder={intl.formatMessage({ id: "chat.question.placeholder", defaultMessage: "Type your answer…" })}
                  rows={3}
                  value={draft.otherText}
                />
              ) : null}
              <div className="thread-async-question__footer">
                {status !== null || error ? <span className="thread-async-question__hint" role="status">
                  {status ?? intl.formatMessage({ id: "chat.question.retry", defaultMessage: "Selection saved. Try again." })}
                </span> : null}
                <Button
                  className="thread-async-question__send"
                  size="sm"
                  disabled={!canAnswer || selected.length === 0}
                  loading={sending}
                  onClick={submitAnswer}
                >{intl.formatMessage({ id: "chat.question.send", defaultMessage: "Send answer" })}<ArrowRight aria-hidden="true" /></Button>
              </div>
            </>
          ) : status !== null ? <p className="thread-async-question__status" role="status">{status}</p> : null}
        </fieldset>
      )}
    </section>
  );
}
