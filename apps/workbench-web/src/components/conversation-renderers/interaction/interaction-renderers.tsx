import { useIntl } from "@opencraft/i18n/react";
import { CheckIcon as Check, ChevronDownIcon as ChevronDown, ChevronLeftIcon as ChevronLeft, ChevronRightIcon as ChevronRight, SearchIcon as Search, CloseIcon as X } from "@opencraft/design-system-web/action-icons";
import { NativeSelect } from "@opencraft/design-system-web/native-controls";
import {
  aggregateUserInputQuestionAnswers,
  selectUserInputQuestionOption,
  createMcpElicitationDraft,
  createUserInputQuestionDrafts,
  normalizeMcpElicitationSchema,
  presentApprovalRequest,
  presentMcpElicitationDisplayValue,
  validateMcpElicitationDraft,
  type AttachedInteractionTimelineBlock,
  type McpElicitationDraft,
  type McpElicitationDraftValue,
  type TimelineBlock,
  type UserInputQuestion,
  type UserInputQuestionDraft,
} from "@opencraft/chat-core";
import { WebChatDocument, resolveStandardChatResource } from "@opencraft/chat-render-web";
import {
  setupContextSourceExamples,
  setupRoleOptions,
  setupTaskOptions,
  type SetupContextSource,
} from "@opencraft/workbench-runtime";
import { AlertIcon as AlertCircle, GlobeIcon as Globe2, MessageIcon as MessageSquare, ToolIcon as Wrench } from "@opencraft/design-system-web/action-icons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react";

import {
  GlobeActivityIcon,
  PatchActivityIcon,
  TerminalActivityIcon,
} from "../../activity-glyphs";
import {
  ActivityDisclosure,
  CadencedShimmer,
} from "../activity/activity-disclosure";
import {
  ConversationInteractionContext,
  SetupContextCatalog,
  type ConversationInteractionAction,
  type ConversationInteractionContextValue,
  type SetupContextCatalogValue,
} from "../render-contexts";

import { ConversationEntryMotionContext } from "../../conversation/entry-motion";
import { interactionDraftIdentity, type InteractionDraftStore } from "./interaction-drafts";

function useInteractionDraftState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const { drafts } = useContext(ConversationInteractionContext);
  const [value, setValue] = useState<T>(() => drafts?.has(key)
    ? drafts.get(key) as T
    : typeof initial === "function" ? (initial as () => T)() : initial);
  const current = useRef(value);
  current.current = value;
  const update = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    const next = typeof action === "function" ? (action as (value: T) => T)(current.current) : action;
    current.current = next;
    drafts?.set(key, next);
    setValue(next);
  }, [drafts, key]);
  return [value, update];
}

function elicitationDraftText(value: McpElicitationDraftValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function useInteractionSubmission(requestId: string) {
  const { respond, responseState, canRespond } = useContext(ConversationInteractionContext);
  const [state, setState] = useState<"idle" | "submitting" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (responseState === undefined || responseState === "pending") { setState("idle"); setError(null); }
  }, [requestId, responseState, canRespond]);
  const submit = useCallback(async (action: ConversationInteractionAction) => {
    if (respond === null || canRespond === false || (responseState !== undefined && responseState !== "pending") || state === "submitting") return;
    setState("submitting");
    setError(null);
    try {
      await respond(requestId, action);
    } catch (cause) {
      setState("failed");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [requestId, respond, state, responseState, canRespond]);
  return { disabled: respond === null || canRespond === false || (responseState !== undefined && responseState !== "pending") || state === "submitting", error, state, submit };
}

function ApprovalBlock({ block }: { block: Extract<TimelineBlock, { type: "approval" }> }) {
  const submission = useInteractionSubmission(block.requestId);
  const presentation = presentApprovalRequest(block);
  const [confirmAlways, setConfirmAlways] = useState(false);
  useEffect(() => setConfirmAlways(false), [block.requestId]);
  const scopedAction: ConversationInteractionAction | null = presentation.scopedApproval === null ? null
    : presentation.scopedApproval.kind === "exec-policy" ? { type: "approve-similar" }
    : { type: "approve-session" };
  const pending = block.state === "pending";
  useEffect(() => {
    if (!pending || submission.disabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable='true']") !== null) return;
      // Focused controls own Enter. The shortcut must not turn a keyboard
      // activation of Deny/Always allow into an implicit one-time grant.
      if (event.key === "Enter" && target instanceof HTMLElement && target.closest("button, a, summary, [role='menuitem']") !== null) return;
      if (event.key === "Escape" && confirmAlways) {
        event.preventDefault();
        setConfirmAlways(false);
        return;
      }
      if (event.key === "Enter" && presentation.allowOnce && !confirmAlways) {
        event.preventDefault();
        void submission.submit({ type: "approve-once" });
      } else if (event.key === "Escape" && presentation.allowDeny && !confirmAlways) {
        event.preventDefault();
        void submission.submit({ type: "decline" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, submission, presentation.allowOnce, presentation.allowDeny, confirmAlways]);
  return (
    <section className="thread-interaction-card thread-approval-request" data-approval-kind={block.approvalKind} data-interaction-kind="approval" data-state={block.state}>
      <div className="thread-interaction-card__copy">
        <div className="thread-approval-request__identity">
          {presentation.identityLabel === "Internet access" ? <GlobeActivityIcon aria-hidden="true" />
            : presentation.identityLabel === "Terminal" ? <TerminalActivityIcon aria-hidden="true" />
            : presentation.identityLabel === "Edit files" ? <PatchActivityIcon aria-hidden="true" />
            : <Wrench aria-hidden="true" size={16} />}
          <span>{presentation.identityLabel}</span>
        </div>
        <strong>{presentation.title}</strong>
        {presentation.subtitle ? <pre className="thread-approval-request__command"><code>{presentation.subtitle}</code></pre> : null}
        {presentation.description ? <p className="thread-approval-request__description">{presentation.description}</p> : null}
        {presentation.details.length > 0 ? <dl className="thread-approval-request__details">{presentation.details.map((detail) => <div key={detail.label}><dt>{detail.label}</dt><dd>{detail.value}</dd></div>)}</dl> : null}
      </div>
      {pending ? (
        <div className="thread-interaction-card__actions">
          {presentation.leadingApproval ? (
            <button className="thread-approval-request__leading-action" disabled={submission.disabled} onClick={() => void submission.submit({ type: "approve-network-host" })} type="button">
              {presentation.leadingApproval.label}
            </button>
          ) : null}
          <button disabled={submission.disabled || !presentation.allowDeny} onClick={() => void submission.submit({ type: "decline" })} type="button">Deny</button>
          {presentation.allowAlways ? confirmAlways ? <>
            <small className="thread-interaction-card__status">Allow similar actions in future conversations?</small>
            <button disabled={submission.disabled} onClick={() => setConfirmAlways(false)} type="button">Cancel</button>
            <button disabled={submission.disabled} title="Remember this permission for future conversations" onClick={() => void submission.submit({ type: "approve-always" })} type="button">Confirm always allow</button>
          </> : <button disabled={submission.disabled} onClick={() => setConfirmAlways(true)} type="button">Always allow</button> : null}
          <div className="thread-approval-request__approve-group">
            <button autoFocus className="is-primary" disabled={submission.disabled || !presentation.allowOnce} onClick={() => void submission.submit({ type: "approve-once" })} type="button"><span>{presentation.approveLabel}</span><kbd>↵</kbd></button>
            {presentation.allowSession && presentation.scopedApproval !== null && scopedAction !== null ? <details>
              <summary aria-label="Approval options"><ChevronDown size={13} /></summary>
              <div className="thread-approval-request__menu" role="menu">
                <button disabled={submission.disabled} onClick={() => void submission.submit({ type: "approve-once" })} role="menuitem" type="button">Allow once</button>
                <button disabled={submission.disabled} onClick={() => void submission.submit(scopedAction)} role="menuitem" title={presentation.scopedApproval.info ?? undefined} type="button">{presentation.scopedApproval.label}</button>
              </div>
            </details> : null}
          </div>
        </div>
      ) : <small>{block.state === "accepted" ? "Allowed" : block.state === "declined" ? "Declined" : "Cancelled"}</small>}
      {submission.state === "submitting" ? <small className="thread-interaction-card__status">Sending response…</small> : null}
      {submission.error ? <small className="thread-interaction-card__error" role="alert">{submission.error}</small> : null}
    </section>
  );
}

function QuestionBlock({ block }: { block: Extract<TimelineBlock, { type: "question" }> }) {
  const submission = useInteractionSubmission(block.requestId);
  const reduceMotion = useReducedMotion();
  const questionsJson = JSON.stringify(block.questions);
  const questions = useMemo<readonly UserInputQuestion[]>(() => JSON.parse(questionsJson), [questionsJson]);
  const [questionIndex, setQuestionIndex] = useInteractionDraftState("questionIndex", 0);
  const [drafts, setDrafts] = useInteractionDraftState<readonly UserInputQuestionDraft[]>("questions", () => createUserInputQuestionDrafts(questions));
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    cardRef.current?.focus();
  }, [questions, block.requestId]);

  const question = questions[questionIndex] ?? questions[0];
  const draft = drafts[questionIndex];
  const isLastQuestion = questionIndex >= questions.length - 1;
  const submitDrafts = useCallback((nextDrafts: readonly UserInputQuestionDraft[]) => {
    const answers = aggregateUserInputQuestionAnswers(questions, nextDrafts);
    if (block.method === "mcpServer/elicitation/request") {
      void submission.submit({ type: "answer", values: Object.values(answers).flat() });
      return;
    }
    void submission.submit({ type: "answer-questions", answers });
  }, [block.method, questions, submission]);
  const completeCurrentQuestion = useCallback((nextDrafts: readonly UserInputQuestionDraft[]) => {
    if (!isLastQuestion) {
      setQuestionIndex((current) => Math.min(current + 1, questions.length - 1));
      requestAnimationFrame(() => cardRef.current?.focus());
      return;
    }
    submitDrafts(nextDrafts);
  }, [questions.length, isLastQuestion, submitDrafts]);
  const updateDraft = useCallback((nextDraft: UserInputQuestionDraft): readonly UserInputQuestionDraft[] => {
    const nextDrafts = [...drafts];
    nextDrafts[questionIndex] = nextDraft;
    setDrafts(nextDrafts);
    return nextDrafts;
  }, [drafts, questionIndex]);
  const selectOption = useCallback((optionId: string, advance = true) => {
    if (!question) return;
    const nextDrafts = updateDraft(selectUserInputQuestionOption(question, draft, optionId));
    if (advance && !question.multiSelect) completeCurrentQuestion(nextDrafts);
  }, [completeCurrentQuestion, draft, question, updateDraft]);
  const submitCurrent = useCallback(() => completeCurrentQuestion(drafts), [completeCurrentQuestion, drafts]);
  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || question === undefined) return;
    const inputTarget = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if (event.key === "Escape") {
      event.preventDefault();
      void submission.submit({ type: "cancel" });
      return;
    }
    if (inputTarget) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitCurrent();
      }
      return;
    }
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && questions.length > 1) {
      event.preventDefault();
      setQuestionIndex((current) => Math.max(0, Math.min(questions.length - 1, current + (event.key === "ArrowRight" ? 1 : -1))));
      return;
    }
    if (event.key >= "1" && event.key <= "9") {
      const option = question.options[Number(event.key) - 1];
      if (option !== undefined) {
        event.preventDefault();
        selectOption(option.id);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (question.options.length === 0) return;
      event.preventDefault();
      const current = Math.max(0, question.options.findIndex((option) => option.id === draft?.selectedOptionId));
      const nextIndex = Math.max(0, Math.min(question.options.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
      const option = question.options[nextIndex];
      if (option !== undefined && !question.multiSelect) selectOption(option.id, false);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submitCurrent();
    }
  }, [questions.length, draft?.selectedOptionId, question, selectOption, submission, submitCurrent]);
  const pending = block.state === "pending";
  if (question === undefined) return null;
  return (
    <section
      aria-label={question.header ?? question.prompt}
      className="thread-interaction-card thread-request-input"
      data-interaction-kind="question"
      data-state={block.state}
      onKeyDown={handleKeyDown}
      ref={cardRef}
      tabIndex={pending ? 0 : -1}
    >
      <AnimatePresence initial={false} mode="wait">
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="thread-request-input__page"
          exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
          initial={reduceMotion ? false : { opacity: 0, y: 4 }}
          key={question.id}
          transition={{ duration: 0.12, ease: "easeOut" }}
        >
          <header className="thread-request-input__header">
            <div className="thread-interaction-card__copy">
              <strong>{question.header ?? question.prompt}</strong>
            </div>
            {questions.length > 1 ? (
              <div className="thread-request-input__pagination" aria-label={`Question ${questionIndex + 1} of ${questions.length}`}>
                <button aria-label="Previous question" disabled={questionIndex === 0 || submission.disabled} onClick={() => setQuestionIndex((current) => Math.max(0, current - 1))} type="button"><ChevronLeft size={13} /></button>
                <span>{questionIndex + 1} of {questions.length}</span>
                <button aria-label="Next question" disabled={isLastQuestion || submission.disabled} onClick={() => setQuestionIndex((current) => Math.min(questions.length - 1, current + 1))} type="button"><ChevronRight size={13} /></button>
              </div>
            ) : null}
          </header>
          {question.header ? <p className="thread-request-input__question">{question.prompt}</p> : null}
          {question.detail ? <div className="thread-request-input__detail"><WebChatDocument documentId={`${block.id}:${question.id}:detail`} source={question.detail} /></div> : null}
          {pending && question.options.length > 0 ? (
            <div className="thread-interaction-card__options">
              {question.options.map((option, index) => (
                <button
                  aria-pressed={question.multiSelect ? draft?.selectedOptionIds?.includes(option.id) === true : draft?.selectedOptionId === option.id}
                  disabled={submission.disabled}
                  key={option.id}
                  onClick={() => selectOption(option.id)}
                  type="button"
                >
                  <kbd>{index + 1}</kbd>
                  <span><b>{option.label}</b>{option.description ? <small>{option.description}</small> : null}</span>
                  <Check aria-hidden="true" size={14} />
                </button>
              ))}
            </div>
          ) : null}
          {pending && (question.options.length === 0 || question.isOther) ? (
            <div className="thread-interaction-card__freeform">
              <input
                aria-label={`Response to ${question.prompt}`}
                disabled={submission.disabled}
                onChange={(event) => updateDraft({ ...draft, selectedOptionId: null, freeformText: event.target.value })}
                placeholder={question.options.length > 0 ? "Other" : "Type here"}
                type={question.isSecret ? "password" : "text"}
                value={draft?.freeformText ?? ""}
              />
            </div>
          ) : null}
        </motion.div>
      </AnimatePresence>
      {pending ? (
        <div className="thread-interaction-card__actions">
          <button className="is-ghost" disabled={submission.disabled} onClick={() => void submission.submit({ type: "cancel" })} type="button">Skip</button>
          <button
            className="is-primary"
            disabled={submission.disabled}
            onClick={submitCurrent}
            type="button"
          >{isLastQuestion ? "Submit" : "Continue"}<kbd>↵</kbd></button>
        </div>
      ) : null}
      {!pending ? <small>{block.state === "answered" ? "Answered" : "Cancelled"}</small> : null}
      {submission.state === "submitting" ? <small className="thread-interaction-card__status">Sending response…</small> : null}
      {submission.error ? <small className="thread-interaction-card__error" role="alert">{submission.error}</small> : null}
    </section>
  );
}

function OptionPickerBlock({ block }: { block: Extract<TimelineBlock, { type: "option-picker" }> }) {
  const submission = useInteractionSubmission(block.requestId);
  const composingRef = useRef(false);
  const [selectedOptions, setSelectedOptions] = useInteractionDraftState<readonly string[]>("options", []);
  const [freeformText, setFreeformText] = useInteractionDraftState("freeform", "");
  const trimmedFreeform = freeformText.trim();
  const hasAnswer = selectedOptions.length > 0 || trimmedFreeform.length > 0;

  const reply = useCallback((action: "submit" | "skip" | "dismiss") => {
    void submission.submit({
      type: "submit-option-picker",
      action,
      selectedOptions,
      freeformAnswer: trimmedFreeform.length > 0 ? trimmedFreeform : null,
    });
  }, [selectedOptions, submission, trimmedFreeform]);

  const toggle = useCallback((label: string) => {
    setSelectedOptions((current) => current.includes(label)
      ? current.filter((candidate) => candidate !== label)
      : block.allowMultiple ? [...current, label] : [label]);
  }, [block.allowMultiple]);

  return (
    <section className="thread-interaction-card thread-option-picker" data-interaction-kind="option-picker" data-state={block.state} onKeyDown={(event) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        reply("dismiss");
      }
    }}>
      <form onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }} onSubmit={(event) => {
        event.preventDefault();
        if (!composingRef.current && hasAnswer) reply("submit");
      }}>
        <header>
          <strong>{block.question}</strong>
          <button aria-label="Dismiss" className="thread-option-picker__dismiss" disabled={submission.disabled} onClick={() => reply("dismiss")} type="button"><X size={12} /></button>
        </header>
        <div className="thread-option-picker__choices">
          {block.options.map((option) => {
            const selected = selectedOptions.includes(option.label);
            return (
              <button
                aria-checked={selected}
                className={selected ? "is-selected" : undefined}
                disabled={submission.disabled}
                key={option.id}
                onClick={() => toggle(option.label)}
                role={block.allowMultiple ? "checkbox" : "radio"}
                title={option.description ?? undefined}
                type="button"
              >{option.label}</button>
            );
          })}
          <input
            aria-label="Something else"
            disabled={submission.disabled}
            onChange={(event) => setFreeformText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.keyCode === 229) {
                // Prevent an implicit form submission after compositionend too.
                if (event.key === "Enter") event.preventDefault();
                return;
              }
              if (event.defaultPrevented || event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                if (hasAnswer) reply("submit");
              }
            }}
            placeholder="Something else"
            value={freeformText}
          />
        </div>
        <footer>
          <button className="is-ghost" disabled={submission.disabled} onClick={() => reply("skip")} type="button">{block.skipLabel ?? "Skip"}</button>
          <button className="is-primary" disabled={submission.disabled || !hasAnswer} type="submit"><span>{block.submitLabel ?? "Submit"}</span><kbd>↵</kbd></button>
        </footer>
        {submission.state === "submitting" ? <small className="thread-interaction-card__status">Sending response…</small> : null}
        {submission.error ? <small className="thread-interaction-card__error" role="alert">{submission.error}</small> : null}
      </form>
    </section>
  );
}

function SetupStepBlock({ block }: { block: Extract<TimelineBlock, { type: "setup-step" }> }) {
  if (block.step === "context") return <SetupContextPickerBlock block={block} />;
  return block.step === "role" ? <SetupRolePickerBlock block={block} /> : <SetupTaskPickerBlock block={block} />;
}

function SetupRolePickerBlock({ block }: { block: Extract<TimelineBlock, { type: "setup-step" }> }) {
  const submission = useInteractionSubmission(block.requestId);
  const [selectedRoles, setSelectedRoles] = useInteractionDraftState<readonly string[]>("setupRoles", []);
  const reply = (action: "submit" | "skip" | "dismiss") => void submission.submit({
    type: "submit-setup-role",
    action,
    selectedRoles: action === "submit" ? selectedRoles : [],
  });
  return <section className="thread-interaction-card thread-option-picker thread-setup-picker" data-interaction-kind="setup-role" data-state={block.state}>
    <header><strong>What type of work do you do?</strong><button aria-label="Dismiss" className="thread-option-picker__dismiss" disabled={submission.disabled} onClick={() => reply("dismiss")} type="button"><X size={12} /></button></header>
    <div className="thread-option-picker__choices thread-setup-picker__roles">
      {setupRoleOptions.map((option) => {
        const selected = selectedRoles.includes(option.id);
        return <button aria-checked={selected} className={selected ? "is-selected" : undefined} disabled={submission.disabled} key={option.id} onClick={() => setSelectedRoles((current) => current.includes(option.id) ? current.filter((id) => id !== option.id) : [...current, option.id])} role="checkbox" type="button">{option.label}</button>;
      })}
    </div>
    <footer><span /><button className="is-primary" disabled={submission.disabled || selectedRoles.length === 0} onClick={() => reply("submit")} type="button"><span>Continue</span><kbd>↵</kbd></button></footer>
    {submission.state === "submitting" ? <small className="thread-interaction-card__status">Sending response…</small> : null}
    {submission.error ? <small className="thread-interaction-card__error" role="alert">{submission.error}</small> : null}
  </section>;
}

function SetupTaskPickerBlock({ block }: { block: Extract<TimelineBlock, { type: "setup-step" }> }) {
  const submission = useInteractionSubmission(block.requestId);
  const [selected, setSelected] = useInteractionDraftState<string | null>("setupTask", null);
  const [other, setOther] = useInteractionDraftState("setupTaskOther", "");
  const answer = selected ?? other.trim();
  const reply = (action: "submit" | "skip" | "dismiss") => void submission.submit({
    type: "submit-setup-task",
    action,
    answers: action === "submit" && answer.length > 0 ? { first_task: [answer] } : {},
  });
  return <section className="thread-interaction-card thread-setup-task" data-interaction-kind="setup-task" data-state={block.state}>
    <header><div><small>First task</small><strong>What's something we can knock off your list today?</strong></div><button aria-label="Dismiss" className="thread-option-picker__dismiss" disabled={submission.disabled} onClick={() => reply("dismiss")} type="button"><X size={12} /></button></header>
    <div className="thread-setup-task__options">
      {setupTaskOptions.map((option) => <button aria-checked={selected === option.label} className={selected === option.label ? "is-selected" : undefined} disabled={submission.disabled} key={option.id} onClick={() => { setSelected(option.label); setOther(""); }} role="radio" type="button"><span><b>{option.label}</b><small>{option.description}</small></span><Check aria-hidden="true" size={14} /></button>)}
    </div>
    <input aria-label="Something else" disabled={submission.disabled} onChange={(event) => { setOther(event.currentTarget.value); setSelected(null); }} placeholder="Something else" value={other} />
    <footer><button className="is-ghost" disabled={submission.disabled} onClick={() => reply("skip")} type="button">Skip</button><button className="is-primary" disabled={submission.disabled || answer.length === 0} onClick={() => reply("submit")} type="button">Continue<kbd>↵</kbd></button></footer>
    {submission.error ? <small className="thread-interaction-card__error" role="alert">{submission.error}</small> : null}
  </section>;
}

function SetupContextPickerBlock({ block }: { block: Extract<TimelineBlock, { type: "setup-step" | "setup-context-picker" }> }) {
  const submission = useInteractionSubmission(block.requestId);
  const catalog = useContext(SetupContextCatalog);
  const [selected, setSelected] = useState<readonly string[]>(() => catalog.sources.filter((source) => source.connected).map((source) => source.id));
  const [search, setSearch] = useInteractionDraftState("setupContextSearch", "");
  const [browseOpen, setBrowseOpen] = useInteractionDraftState("setupContextBrowseOpen", false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSelected(catalog.sources.filter((source) => source.connected).map((source) => source.id));
    setConnecting(null);
    setError(null);
  }, [block.requestId, catalog.sources]);
  const filtered = catalog.sources.filter((source) => `${source.label} ${source.description}`.toLowerCase().includes(search.trim().toLowerCase()));
  const reply = (action: "continue" | "skip" | "dismiss") => void submission.submit({
    type: "submit-setup-context",
    action,
    selectedSources: action === "continue" ? selected : [],
  });
  const choose = async (source: SetupContextSource) => {
    if (source.connected || selected.includes(source.id)) {
      setSelected((current) => current.includes(source.id) ? current.filter((id) => id !== source.id) : [...current, source.id]);
      return;
    }
    if (!source.available || catalog.connect === null) return;
    setConnecting(source.id);
    setError(null);
    try {
      await catalog.connect(source);
      setSelected((current) => current.includes(source.id) ? current : [...current, source.id]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnecting(null);
    }
  };
  const sourceRows = (sources: readonly SetupContextSource[]) => sources.map((source) => {
    const isSelected = selected.includes(source.id);
    return <button className={isSelected ? "is-selected" : undefined} disabled={submission.disabled || connecting === source.id || !source.connected && (!source.available || catalog.connect === null)} key={source.id} onClick={() => void choose(source)} type="button"><span className="thread-setup-context__logo" aria-hidden="true">{source.label.slice(0, 1)}</span><span><b>{source.label}</b><small>{source.description}</small></span><em>{connecting === source.id ? "Connecting…" : isSelected || source.connected ? "Connected" : "Connect"}</em>{isSelected ? <Check aria-hidden="true" size={14} /> : null}</button>;
  });
  return <section className="thread-interaction-card thread-setup-context" data-interaction-kind="setup-context" data-state={block.state}>
    <header><strong>Where can we pull context from?</strong><button aria-label="Dismiss" className="thread-option-picker__dismiss" disabled={submission.disabled} onClick={() => reply("dismiss")} type="button"><X size={12} /></button></header>
    <div className="thread-setup-context__sources">{sourceRows(catalog.sources.slice(0, 3))}</div>
    <details className="thread-setup-context__browse" onToggle={(event) => setBrowseOpen(event.currentTarget.open)} open={browseOpen}><summary>Browse all<Search aria-hidden="true" size={12} /></summary><div><input aria-label="Search apps and plugins" onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Search apps and plugins" value={search} />{catalog.loading ? <small>Loading apps…</small> : filtered.length > 0 ? sourceRows(filtered) : <small>No apps found</small>}</div></details>
    {error ? <small className="thread-interaction-card__error" role="alert">{error}</small> : null}
    <footer><button className="is-ghost" disabled={submission.disabled} onClick={() => reply("skip")} type="button">Skip</button><button className="is-primary" disabled={submission.disabled || catalog.loading} onClick={() => reply("continue")} type="button"><span>Continue</span><kbd>↵</kbd></button></footer>
  </section>;
}

function McpToolApprovalBlock({ block }: { block: Extract<TimelineBlock, { type: "elicitation" }> }) {
  const submission = useInteractionSubmission(block.requestId);
  const approval = block.toolApproval;
  const [showAll, setShowAll] = useInteractionDraftState("reviewShowAll", false);
  const [expanded, setExpanded] = useInteractionDraftState<Readonly<Record<string, boolean>>>("reviewExpanded", {});
  const pending = block.state === "pending";
  const connectorName = approval?.connectorName ?? block.serverName ?? "Connector";
  const toolName = approval?.toolTitle ?? approval?.toolName;
  const title = block.message.trim().length > 0
    ? block.message
    : toolName === null || toolName === undefined
      ? `Allow ${connectorName} to run this tool?`
      : `Allow ${connectorName} to run ${toolName} tool?`;
  const entries = approval?.toolParamsDisplay.length
    ? approval.toolParamsDisplay
    : Object.entries(approval?.toolParams ?? {}).map(([name, value]) => ({ name, displayName: name, value }));
  const visibleEntries = showAll ? entries : entries.slice(0, 4);
  useEffect(() => {
    if (!pending || submission.disabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable='true']") !== null) return;
      // Buttons and disclosure controls own their native Enter activation.
      if (event.key === "Enter" && target instanceof HTMLElement && target.closest("button, a, summary, [role='menuitem']") !== null) return;
      if (event.key === "Enter") {
        event.preventDefault();
        void submission.submit({ type: "accept-elicitation" });
      } else if (event.key === "Escape") {
        event.preventDefault();
        void submission.submit({ type: "decline" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pending, submission]);
  return (
    <section className="thread-interaction-card thread-mcp-tool-approval" data-interaction-kind="mcp-tool-approval" data-risk-level={block.riskLevel ?? "none"} data-state={block.state}>
      <div className="thread-interaction-card__copy">
        <header className="thread-mcp-tool-approval__header">
          {block.riskLevel === "high" ? <span className="thread-mcp-tool-approval__risk"><AlertCircle aria-hidden="true" size={14} />Elevated Risk</span> : <span className="thread-mcp-tool-approval__connector"><Wrench aria-hidden="true" size={15} />{connectorName}</span>}
        </header>
        <strong className="thread-mcp-tool-approval__title">{title}</strong>
        {block.subtitle ? <small className="thread-mcp-tool-approval__subtitle">{block.subtitle}</small> : null}
        {visibleEntries.length > 0 ? <dl className="thread-mcp-tool-approval__params">{visibleEntries.map((entry, index) => {
          const key = `${entry.name}:${index}`;
          const value = presentMcpElicitationDisplayValue(entry.value);
          const expandable = value.isExpandable;
          const open = expanded[key] === true;
          return <div key={key}>
            <dt>{entry.displayName}</dt>
            <dd><span data-display-kind={value.kind} data-expandable={expandable || undefined} data-expanded={open || undefined}>{open ? value.expandedText : value.previewText}</span>{expandable ? <button aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${entry.displayName}`} onClick={() => setExpanded((current) => ({ ...current, [key]: !open }))} type="button">{open ? "Collapse" : "Expand"}<ChevronDown aria-hidden="true" size={11} /></button> : null}</dd>
          </div>;
        })}</dl> : null}
        {entries.length > 4 ? <button className="thread-mcp-tool-approval__more" onClick={() => setShowAll((value) => !value)} type="button">{showAll ? "Show fewer items" : `Show ${entries.length - 4} more items`}<ChevronDown aria-hidden="true" size={12} /></button> : null}
      </div>
      {pending ? <div className="thread-interaction-card__actions">
        <button disabled={submission.disabled} onClick={() => void submission.submit({ type: "decline" })} type="button">Deny</button>
        <div className="thread-approval-request__approve-group">
          <button autoFocus className="is-primary" disabled={submission.disabled} onClick={() => void submission.submit({ type: "accept-elicitation" })} type="button"><span>Allow once</span><kbd>↵</kbd></button>
          {block.persist.length > 0 ? <details>
            <summary aria-label="Approval options"><ChevronDown size={13} /></summary>
            <div className="thread-approval-request__menu" role="menu">
              <button disabled={submission.disabled} onClick={() => void submission.submit({ type: "accept-elicitation" })} role="menuitem" type="button">Allow once</button>
              {block.persist.includes("session") ? <button disabled={submission.disabled} onClick={() => void submission.submit({ type: "accept-elicitation", persist: "session" })} role="menuitem" type="button">Allow this conversation</button> : null}
              {block.persist.includes("always") ? <button disabled={submission.disabled} onClick={() => void submission.submit({ type: "accept-elicitation", persist: "always" })} role="menuitem" type="button">Always allow</button> : null}
            </div>
          </details> : null}
        </div>
      </div> : <small>{block.state === "accepted" ? "Allowed" : block.state === "declined" ? "Declined" : "Cancelled"}</small>}
      {submission.state === "submitting" ? <small className="thread-interaction-card__status">Sending response…</small> : null}
      {submission.error ? <small className="thread-interaction-card__error" role="alert">{submission.error}</small> : null}
    </section>
  );
}

function McpToolSuggestionBlock({ block }: { block: Extract<TimelineBlock, { type: "elicitation" }> }) {
  const submission = useInteractionSubmission(block.requestId);
  const suggestion = block.toolSuggestion;
  const [setupStarted, setSetupStarted] = useState(false);
  const [persistChecked, setPersistChecked] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  if (suggestion === null) return null;
  const installDecision = suggestion.installUrl === null ? null : resolveStandardChatResource(suggestion.installUrl, { externalResourcePolicy: "allow" });
  const decline = () => submission.submit({ type: "decline", ...(persistChecked && suggestion.persistAlways ? { persist: "always" as const } : {}) });
  const primary = () => {
    if (setupStarted) {
      void submission.submit({ type: "accept-elicitation", ...(persistChecked && suggestion.persistAlways ? { persist: "always" as const } : {}) });
      return;
    }
    if (installDecision?.allowed === true && installDecision.target !== null) {
      window.open(installDecision.target, "_blank", "noopener,noreferrer");
      setSetupStarted(true);
      setSetupError(null);
      return;
    }
    setSetupError(`This host must ${suggestion.suggestType} ${suggestion.toolName} before continuing.`);
  };
  return (
    <section className="thread-interaction-card thread-external-tool-request" data-interaction-kind="tool-suggestion" data-state={block.state}>
      <div className="thread-interaction-card__copy">
        <header><Wrench aria-hidden="true" size={16} /><strong>{suggestion.toolName}</strong></header>
        <p>{suggestion.suggestReason}</p>
        {block.subtitle ? <small>{block.subtitle}</small> : null}
        {setupError ? <small className="thread-interaction-card__error" role="alert">{setupError}</small> : null}
      </div>
      {block.state === "pending" ? <div className="thread-external-tool-request__footer">
        {suggestion.persistAlways ? <label><input checked={persistChecked} disabled={submission.disabled} onChange={(event) => setPersistChecked(event.target.checked)} type="checkbox" /><span>Don't show again</span></label> : <span />}
        <div className="thread-interaction-card__actions">
          <button className="is-ghost" disabled={submission.disabled} onClick={() => void decline()} type="button">Not now</button>
          <button autoFocus className="is-primary" disabled={submission.disabled} onClick={primary} type="button">{setupStarted ? "Continue" : suggestion.suggestType === "install" ? "Install" : "Enable"}<kbd>↵</kbd></button>
        </div>
      </div> : null}
    </section>
  );
}

function McpConnectorAuthBlock({ block }: { block: Extract<TimelineBlock, { type: "elicitation" }> }) {
  const submission = useInteractionSubmission(block.requestId);
  const auth = block.connectorAuth;
  const [setupStarted, setSetupStarted] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  if (auth === null) return null;
  const authDecision = resolveStandardChatResource(auth.installUrl || block.url || "", { externalResourcePolicy: "allow" });
  const primaryLabel = setupStarted ? "Continue"
    : auth.authReason === "missing_link" ? "Connect"
    : auth.authReason === "oauth_upgrade_required" ? "Update access"
    : "Reconnect";
  const primary = () => {
    if (setupStarted) {
      void submission.submit({ type: "accept-elicitation" });
      return;
    }
    if (authDecision.allowed && authDecision.target !== null) {
      window.open(authDecision.target, "_blank", "noopener,noreferrer");
      setSetupStarted(true);
      setSetupError(null);
      return;
    }
    setSetupError("The connector setup URL is unavailable.");
  };
  return (
    <section className="thread-interaction-card thread-external-tool-request" data-interaction-kind="connector-auth" data-state={block.state}>
      <div className="thread-interaction-card__copy">
        <header><Globe2 aria-hidden="true" size={16} /><strong>{auth.connectorName}</strong></header>
        <p>{block.message}</p>
        {auth.requestedScopes.length > 0 ? <small>{auth.requestedScopes.join(" · ")}</small> : null}
        {setupError ? <small className="thread-interaction-card__error" role="alert">{setupError}</small> : null}
      </div>
      {block.state === "pending" ? <div className="thread-external-tool-request__footer">
        <span />
        <div className="thread-interaction-card__actions">
          <button className="is-ghost" disabled={submission.disabled} onClick={() => void submission.submit({ type: "decline" })} type="button">Not now</button>
          <button autoFocus className="is-primary" disabled={submission.disabled} onClick={primary} type="button">{primaryLabel}<kbd>↵</kbd></button>
        </div>
      </div> : null}
    </section>
  );
}

function McpFormElicitationBlock({ block }: { block: Extract<TimelineBlock, { type: "elicitation" }> }) {
  const submission = useInteractionSubmission(block.requestId);
  const fields = useMemo(() => normalizeMcpElicitationSchema(block.requestedSchema), [block.requestedSchema]);
  const [draft, setDraft] = useInteractionDraftState<McpElicitationDraft>("form", () => createMcpElicitationDraft(fields));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const update = (name: string, value: McpElicitationDraftValue) => {
    setDraft((current) => ({ ...current, [name]: value }));
    setErrors((current) => current[name] === undefined ? current : Object.fromEntries(Object.entries(current).filter(([key]) => key !== name)));
  };
  const submitForm = () => {
    const result = validateMcpElicitationDraft(fields, draft);
    setErrors(result.errors);
    if (result.content !== null) void submission.submit({ type: "accept-elicitation", content: result.content });
  };
  const pending = block.state === "pending";
  const urlDecision = block.url === null ? null : resolveStandardChatResource(block.url, { externalResourcePolicy: "allow" });
  return (
    <section className="thread-interaction-card thread-elicitation" data-interaction-kind="elicitation" data-state={block.state}>
      <header className="thread-elicitation__header">
        <strong>{block.serverName === null ? "Additional information required" : `${block.serverName} needs more information`}</strong>
        <small>{block.mode === "url" ? "Open a secure page to continue" : "Review and submit the requested fields"}</small>
      </header>
      <p>{block.message}</p>
      {pending && block.mode === "url" ? <div className="thread-elicitation__url">
        {urlDecision?.allowed === true && urlDecision.target !== null
          ? <a href={urlDecision.target} rel="noreferrer" target="_blank">{block.url}</a>
          : <code>{block.url ?? "No URL supplied"}</code>}
      </div> : null}
      {pending && block.mode !== "url" ? <div className="thread-elicitation__form">
        {fields.length === 0 ? <div className="thread-elicitation__unsupported"><small>The server supplied an open form. Submit an empty response or decline.</small></div> : null}
        {fields.map((field) => <label className="thread-elicitation__field" key={field.name}>
          <span><b>{field.title}</b>{field.required ? <i>Required</i> : null}</span>
          {field.description ? <small>{field.description}</small> : null}
          {field.kind === "boolean" ? <button aria-pressed={draft[field.name] === true} onClick={() => update(field.name, draft[field.name] !== true)} type="button"><span>{draft[field.name] === true ? "Enabled" : "Disabled"}</span><Check size={14} /></button>
            : field.kind === "select" ? <NativeSelect onChange={(event) => update(field.name, event.target.value)} value={elicitationDraftText(draft[field.name])}>{field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</NativeSelect>
            : field.kind === "multi-select" ? <div className="thread-elicitation__checks">{field.options.map((option) => {
                const values = Array.isArray(draft[field.name]) ? draft[field.name] as readonly string[] : [];
                return <label key={option.value}><input checked={values.includes(option.value)} onChange={() => update(field.name, values.includes(option.value) ? values.filter((value) => value !== option.value) : [...values, option.value])} type="checkbox" />{option.label}</label>;
              })}</div>
            : <input
                className={field.kind === "number" ? "ui-native-number" : undefined}
                max={field.maximum ?? undefined}
                maxLength={field.maxLength ?? undefined}
                min={field.minimum ?? undefined}
                minLength={field.minLength ?? undefined}
                onChange={(event) => update(field.name, event.target.value)}
                type={field.kind === "number" ? "number" : field.format === "password" ? "password" : field.format === "email" ? "email" : "text"}
                value={elicitationDraftText(draft[field.name])}
              />}
          {errors[field.name] ? <em role="alert">{errors[field.name]}</em> : null}
        </label>)}
      </div> : null}
      {pending ? <div className="thread-interaction-card__actions">
        <button disabled={submission.disabled} onClick={() => void submission.submit({ type: "decline" })} type="button">Decline</button>
        <button className="is-primary" disabled={submission.disabled} onClick={block.mode === "url" ? () => void submission.submit({ type: "accept-elicitation" }) : submitForm} type="button">Continue</button>
      </div> : <small>{block.state}</small>}
      {submission.state === "submitting" ? <small className="thread-interaction-card__status">Sending response…</small> : null}
      {submission.error ? <small className="thread-interaction-card__error" role="alert">{submission.error}</small> : null}
    </section>
  );
}

function ElicitationBlock({ block }: { block: Extract<TimelineBlock, { type: "elicitation" }> }) {
  if (block.interactionKind === "tool-approval" && block.toolApproval !== null) return <McpToolApprovalBlock block={block} />;
  if (block.interactionKind === "tool-suggestion" && block.toolSuggestion !== null) return <McpToolSuggestionBlock block={block} />;
  if (block.interactionKind === "connector-auth" && block.connectorAuth !== null) return <McpConnectorAuthBlock block={block} />;
  return <McpFormElicitationBlock block={block} />;
}

export interface ConversationPendingInteractionPanelProps {
  readonly block: AttachedInteractionTimelineBlock | null;
  readonly onRespondInteraction?: (requestId: string, action: ConversationInteractionAction) => Promise<void>;
  readonly setupContextSources?: readonly SetupContextSource[];
  readonly setupContextLoading?: boolean;
  readonly onConnectSetupContextSource?: (source: SetupContextSource) => Promise<void>;
  readonly draftStore?: InteractionDraftStore;
  readonly draftScope?: string;
  readonly requestTurnId?: string | null;
}

export function ConversationPendingInteractionPanel({
  block,
  onRespondInteraction,
  setupContextSources = setupContextSourceExamples,
  setupContextLoading = false,
  onConnectSetupContextSource,
  draftStore,
  draftScope,
  requestTurnId,
}: ConversationPendingInteractionPanelProps) {
  const intl = useIntl();
  const allowEntryMotion = useContext(ConversationEntryMotionContext);
  const reduceMotion = useReducedMotion();
  const identity = block === null ? null : JSON.stringify([requestTurnId, interactionDraftIdentity(block)]);
  const entry = useMemo(() => identity === null || draftScope === undefined ? undefined : draftStore?.prepare(draftScope, identity), [draftScope, draftStore, identity]);
  useLayoutEffect(() => {
    if (entry !== undefined && draftScope !== undefined) draftStore?.retain(draftScope, entry);
  }, [draftScope, draftStore, entry]);
  const interactionContext = useMemo<ConversationInteractionContextValue>(() => ({
    drafts: entry?.values,
    responseState: block?.responseState,
    canRespond: block?.canRespond,
    respond: onRespondInteraction === undefined ? null : async (requestId, action) => {
      await onRespondInteraction(requestId, action);
      if (entry !== undefined && draftScope !== undefined) draftStore?.release(draftScope, entry);
    },
  }), [draftScope, draftStore, entry, onRespondInteraction, block?.responseState, block?.canRespond]);
  const setupCatalog = useMemo<SetupContextCatalogValue>(() => ({
    sources: setupContextSources,
    loading: setupContextLoading,
    connect: onConnectSetupContextSource ?? null,
  }), [onConnectSetupContextSource, setupContextLoading, setupContextSources]);
  if (block === null) return null;
  return (
    <ConversationInteractionContext.Provider value={interactionContext}>
      <SetupContextCatalog.Provider value={setupCatalog}>
      <motion.div
        key={identity}
        animate={{ opacity: 1, y: 0 }}
        className="thread-pending-request-panel"
        data-pending-request-id={block.requestId}
        initial={reduceMotion || !allowEntryMotion ? false : { opacity: 0, y: 6 }}
        transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.2, 0, 0, 1] }}
      >
        {block.responseState === "responding" || block.responseState === "unconfirmed" || block.canRespond === false
          ? <p role="status" className="thread-interaction-card__status">{intl.formatMessage(block.responseState === "unconfirmed"
            ? { id: "chat.interaction.unconfirmed", defaultMessage: "Response delivery is unconfirmed. Reconnecting will check its status." }
            : block.responseState === "responding" ? { id: "chat.interaction.responding", defaultMessage: "A response was submitted. Waiting for the server to confirm…" }
            : { id: "chat.interaction.readOnly", defaultMessage: "This request cannot be answered from this view right now." })}</p> : null}
        {block.type === "approval"
          ? <ApprovalBlock block={block} />
          : block.type === "question"
            ? <QuestionBlock block={block} />
            : block.type === "option-picker"
              ? <OptionPickerBlock block={block} />
              : block.type === "setup-step"
                ? <SetupStepBlock block={block} />
                : block.type === "setup-context-picker"
                  ? <SetupContextPickerBlock block={block} />
                  : <ElicitationBlock block={block} />}
      </motion.div>
      </SetupContextCatalog.Provider>
    </ConversationInteractionContext.Provider>
  );
}

export function InteractionTimelineStatusBlock({ block }: { readonly block: AttachedInteractionTimelineBlock }): ReactNode {
  if (block.type === "question" || block.type === "option-picker" || block.type === "setup-step" || block.type === "setup-context-picker") return null;
  if (block.state === "pending") {
    return (
      <div aria-live="polite" className="thread-awaiting-approval" data-interaction-kind={block.type}>
        <CadencedShimmer active>Awaiting approval</CadencedShimmer>
      </div>
    );
  }
  if (block.type === "approval") return null;
  const answer = block.state === "accepted" ? "Accepted" : block.state === "declined" ? "Declined" : "Cancelled";
  return (
    <ActivityDisclosure
      detail={answer}
      icon={<MessageSquare />}
      onOpenChange={() => undefined}
      open={false}
      running={false}
      status="completed"
      summary="Completed request"
    />
  );
}
