import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppServerMethodParams, AppServerMethodResult, OnboardingAgentSnapshot, OnboardingSnapshot } from "@opencraft/appserver-protocol";
import { useIntl } from "@opencraft/i18n/react";
import { CheckIcon } from "@opencraft/design-system-web/action-icons";
import { AgentBrandIcon } from "@opencraft/design-system-web/action-icons";
import { Button } from "./ui/button";
import "./agent-onboarding.scss";

type OnboardingMethod = "opencraft/agents/onboarding/status" | "opencraft/agents/onboarding/act" | "opencraft/agents/onboarding/models";
type OnboardingRequest = <M extends OnboardingMethod>(method: M, params: AppServerMethodParams<M>) => Promise<AppServerMethodResult<M>>;

const DEFAULT_MODELS: Record<string, string> = { codex: "codex:current", cursor: "cursor:current", claude: "claude-code:current", codebuddy: "codebuddy:current" };

const AGENT_NAMES: Record<string, { id: string; defaultMessage: string }> = {
  codex: { id: "onboard.agent.codex", defaultMessage: "Codex" },
  cursor: { id: "onboard.agent.cursor", defaultMessage: "Cursor" },
  claude: { id: "onboard.agent.claude", defaultMessage: "Claude" },
  codebuddy: { id: "onboard.agent.codebuddy", defaultMessage: "CodeBuddy" },
};

function isSnapshot(value: unknown): value is OnboardingSnapshot {
  return !!value && typeof value === "object" && Array.isArray((value as OnboardingSnapshot).agents);
}

interface AgentOnboardingProps {
  readonly hostId: string;
  readonly hostName: string;
  readonly request: OnboardingRequest;
  readonly presentation: "gate" | "sheet";
  readonly onFinish: (modelId: string) => void;
  readonly onUseModels: () => void;
  readonly onClose?: () => void;
}

export function AgentOnboarding(props: AgentOnboardingProps) {
  return <AgentOnboardingContent key={props.hostId} {...props} />;
}

function AgentOnboardingContent({ hostId, hostName, request, presentation, onFinish, onUseModels, onClose }: AgentOnboardingProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const queryKey = ["agent-onboarding", hostId] as const;
  const [copied, setCopied] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [requestedStep, setStep] = useState<"agent" | "start">("agent");
  const [chosenAgent, setChosenAgent] = useState<string | null>(null);
  const [chosenModel, setChosenModel] = useState<{ agentId: string; id: string; name: string } | null>(null);
  const status = useQuery({
    queryKey,
    retry: false,
    queryFn: async () => {
      const result = await request("opencraft/agents/onboarding/status", {});
      if (!isSnapshot(result)) throw new Error("invalid");
      return result;
    },
    refetchInterval: query => query.state.data?.agents.some(agent => agent.activity?.phase === "running") ? 2000 : false,
  });
  const nameOf = (id: string) => intl.formatMessage(AGENT_NAMES[id] ?? { id: "onboard.agent.unknownName", defaultMessage: "Agent" });
  const run = async (id: string, action: "sign-in" | "install" | "cancel") => {
    setPendingId(id);
    try {
      const result = await request("opencraft/agents/onboarding/act", { id, action });
      if (isSnapshot(result)) queryClient.setQueryData(queryKey, result);
    } finally { setPendingId(null); }
  };
  const copyCode = async (id: string, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(id);
    } catch { setCopied(null); }
  };
  const agents = status.data?.agents;
  const readyAgents = agents?.filter(agent => agent.authenticated === true && agent.activity?.phase !== "running") ?? [];
  const expanded = readyAgents.find(agent => agent.id === chosenAgent)?.id ?? readyAgents[0]?.id ?? null;
  const agentModels = useQuery({
    queryKey: [...queryKey, "models", expanded],
    enabled: expanded !== null,
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      const result = await request("opencraft/agents/onboarding/models", { id: expanded! });
      if (!result || !Array.isArray(result.models) || result.models.some(model => !model || typeof model.id !== "string" || !model.id || typeof model.name !== "string")) {
        throw new Error("Invalid agent models");
      }
      return result.models;
    },
  });
  const models = agentModels.data ?? [];
  const defaultModel = expanded ? DEFAULT_MODELS[expanded] : undefined;
  const selectedChoice = chosenModel?.agentId === expanded ? chosenModel : null;
  const selected = models.find(model => model.id === selectedChoice?.id) ?? models[0]
    ?? (!agentModels.isPending && selectedChoice?.id === defaultModel ? selectedChoice : null);
  const selectedModel = selected?.id ?? null;
  const selectedModelName = selected?.name ?? null;
  const step = requestedStep === "start" && selectedModel ? "start" : "agent";
  return <div className={presentation === "sheet" ? "agent-onboard-gate agent-onboard-gate--sheet" : "agent-onboard-gate"} role="dialog" aria-modal={presentation === "gate"} aria-labelledby="agent-onboard-title">
    <section className="agent-onboard" aria-labelledby="agent-onboard-title">
    {presentation === "sheet" ? <button type="button" className="agent-onboard__back" onClick={onClose}>{intl.formatMessage({ id: "onboard.agent.backToSettings", defaultMessage: "Back to model settings" })}</button> : null}
    <ol className="agent-onboard__steps">
      <li data-current={step === "agent"}>{intl.formatMessage({ id: "onboard.agent.stepAgent", defaultMessage: "1 · Agent" })}</li>
      <li data-current={step === "start"}>{intl.formatMessage({ id: "onboard.agent.stepStart", defaultMessage: "2 · Start" })}</li>
    </ol>
    <header className="agent-onboard__intro">
      <h2 id="agent-onboard-title">{intl.formatMessage({ id: "onboard.agent.title", defaultMessage: "Connect a coding agent" })}</h2>
      <p>{step === "start" && selectedModelName
        ? intl.formatMessage({ id: "onboard.agent.readyBody", defaultMessage: "New chats will use {name}. You can switch agents later from the model menu." }, { name: selectedModelName })
        : intl.formatMessage({ id: "onboard.agent.description", defaultMessage: "Install and sign in to an agent you already use. Choose one of its models to start chatting." })}</p>
    </header>
    <div className="agent-onboard__meta">
      <span>{intl.formatMessage({ id: "onboard.agent.host", defaultMessage: "On {host}" }, { host: hostName })}</span>
      <button type="button" onClick={() => { void status.refetch(); }} disabled={status.isFetching}>
        {intl.formatMessage({ id: "onboard.agent.recheck", defaultMessage: "Check again" })}
      </button>
    </div>
    {status.isPending ? <ul className="agent-onboard__list" aria-hidden="true">
      {[0, 1, 2, 3].map(index => <li key={index} className="agent-onboard__skeleton" />)}
    </ul> : null}
    {status.isError ? <p className="agent-onboard__note">{intl.formatMessage({ id: "onboard.agent.unavailable", defaultMessage: "This host can't check local agents yet. You can still configure a model." })}</p> : null}
    {step === "agent" && agents ? <ul className="agent-onboard__list">
      {agents.map((agent: OnboardingAgentSnapshot) => {
        const activity = agent.activity;
        const ready = agent.authenticated === true && activity?.phase !== "running";
        const subline = activity?.phase === "running"
          ? intl.formatMessage(activity.kind === "install"
            ? { id: "onboard.agent.installing", defaultMessage: "Installing…" }
            : { id: "onboard.agent.signingIn", defaultMessage: "Finish signing in below" })
          : activity?.phase === "failed"
            ? activity.message || intl.formatMessage(activity.kind === "install"
              ? { id: "onboard.agent.installFailed", defaultMessage: "Install didn't finish" }
              : { id: "onboard.agent.signInFailed", defaultMessage: "Sign-in didn't finish" })
            : !agent.installed
              ? intl.formatMessage({ id: "onboard.agent.notInstalled", defaultMessage: "Not installed" })
              : agent.authenticated === true
                ? agent.account
                  ? intl.formatMessage({ id: "onboard.agent.account", defaultMessage: "Signed in as {account}" }, { account: agent.account })
                  : intl.formatMessage({ id: "onboard.agent.signedIn", defaultMessage: "Signed in" })
                : agent.authenticated === false
                  ? intl.formatMessage({ id: "onboard.agent.signInNeeded", defaultMessage: "Installed · not signed in" })
                  : intl.formatMessage({ id: "onboard.agent.unknown", defaultMessage: "Couldn't check this agent" });
        return <li key={agent.id} data-agent={agent.id} data-selected={expanded === agent.id}>
          <div className="agent-onboard__row">
            <span className="agent-onboard__mark" data-agent={agent.id} aria-hidden="true">
              <AgentBrandIcon agent={agent.id} />
            </span>
            <span className="agent-onboard__copy">
              <span className="agent-onboard__name">{nameOf(agent.id)}</span>
              <span className={activity?.phase === "failed" ? "agent-onboard__detail agent-onboard__detail--failed" : "agent-onboard__detail"}>{subline}</span>
            </span>
            <span className="agent-onboard__actions">
              {ready ? <span className="agent-onboard__ready">{intl.formatMessage({ id: "onboard.agent.ready", defaultMessage: "Ready" })}</span> : null}
              {ready ? <Button size="sm" variant="ghost" aria-expanded={expanded === agent.id} aria-controls={`agent-models-${agent.id}`} onClick={() => setChosenAgent(agent.id)}>
                {intl.formatMessage({ id: "onboard.agent.chooseModels", defaultMessage: "Choose models" })}
              </Button> : null}
              {activity?.phase === "running" ? <Button size="sm" variant="ghost" disabled={pendingId === agent.id} onClick={() => { void run(agent.id, "cancel"); }}>
                {intl.formatMessage({ id: "onboard.agent.cancel", defaultMessage: "Cancel" })}
              </Button> : null}
              {activity?.phase === "failed" ? <Button size="sm" variant="outline" disabled={pendingId === agent.id} onClick={() => { void run(agent.id, activity.kind); }}>
                {intl.formatMessage({ id: "onboard.agent.retry", defaultMessage: "Retry" })}
              </Button> : null}
              {!activity && !agent.installed ? <Button size="sm" variant="outline" disabled={pendingId === agent.id} onClick={() => {
                if (agent.canInstallPackage) void run(agent.id, "install");
                else window.open(agent.installUrl, "_blank", "noopener,noreferrer");
              }}>
                {intl.formatMessage({ id: "onboard.agent.install", defaultMessage: "Install" })}
              </Button> : null}
              {!activity && agent.installed && agent.authenticated === false ? <Button size="sm" disabled={pendingId === agent.id} onClick={() => { void run(agent.id, "sign-in"); }}>
                {intl.formatMessage({ id: "onboard.agent.signIn", defaultMessage: "Sign in" })}
              </Button> : null}
            </span>
          </div>
          {ready && expanded === agent.id ? <div className="agent-onboard__models" id={`agent-models-${agent.id}`}>
            {agentModels.isPending ? <p role="status">{intl.formatMessage({ id: "onboard.agent.modelsLoading", defaultMessage: "Reading this agent's models…" })}</p> : null}
            {agentModels.isError || (agentModels.isSuccess && models.length === 0) ? <>
              <p role="status">{intl.formatMessage({ id: "onboard.agent.modelsFailed", defaultMessage: "Couldn't read this agent's models. You can still continue with its default." })}</p>
              <div className="agent-onboard__model-actions">
                <Button size="sm" variant="ghost" disabled={agentModels.isFetching} onClick={() => { void agentModels.refetch(); }}>{intl.formatMessage({ id: "onboard.agent.retry", defaultMessage: "Retry" })}</Button>
                {defaultModel ? <Button size="sm" variant="outline" aria-pressed={selectedModel === defaultModel} onClick={() => setChosenModel({ agentId: agent.id, id: defaultModel, name: nameOf(agent.id) })}>{intl.formatMessage({ id: "onboard.agent.useDefault", defaultMessage: "Use the default model" })}</Button> : null}
              </div>
            </> : null}
            {models.length > 0 ? <ul>
              {models.map(model => <li key={model.id}>
                <Button size="sm" variant={selectedModel === model.id ? "outline" : "ghost"} contentLayout="row" aria-pressed={selectedModel === model.id} onClick={() => setChosenModel({ agentId: agent.id, ...model })}>
                  {model.name}{selectedModel === model.id ? <CheckIcon size={14} aria-hidden="true" /> : null}
                </Button>
              </li>)}
            </ul> : null}
          </div> : null}
          {activity?.kind === "sign-in" ? <div className="agent-onboard__guide">
            {activity.url ? <a href={activity.url} target="_blank" rel="noreferrer">{intl.formatMessage({ id: "onboard.agent.openLogin", defaultMessage: "Open sign-in page" })}</a> : <span>{intl.formatMessage({ id: "onboard.agent.waiting", defaultMessage: "Waiting for the sign-in link…" })}</span>}
            {activity.userCode ? <span className="agent-onboard__code">
              <code>{activity.userCode}</code>
              <button type="button" onClick={() => { void copyCode(agent.id, activity.userCode!); }}>
                {copied === agent.id
                  ? intl.formatMessage({ id: "onboard.agent.copied", defaultMessage: "Copied" })
                  : intl.formatMessage({ id: "onboard.agent.copyCode", defaultMessage: "Copy code" })}
              </button>
            </span> : null}
            {activity.log ? <details>
              <summary className="ui-native-disclosure">{intl.formatMessage({ id: "onboard.agent.viewLog", defaultMessage: "View log" })}</summary>
              <pre>{activity.log}</pre>
            </details> : null}
          </div> : null}
          {activity?.kind === "install" && activity.log ? <details className="agent-onboard__guide">
            <summary className="ui-native-disclosure">{intl.formatMessage({ id: "onboard.agent.viewLog", defaultMessage: "View log" })}</summary>
            <pre>{activity.log}</pre>
          </details> : null}
        </li>;
      })}
    </ul> : null}
    {step === "agent" ? <p className="agent-onboard__note">{intl.formatMessage({ id: "onboard.agent.other", defaultMessage: "Don't see your agent? Other installed ACP agents can be connected the same way once OpenCraft recognizes their command." })}</p> : null}
    <div className="agent-onboard__footer">
      {step === "start" ? <Button variant="ghost" onClick={() => setStep("agent")}>{intl.formatMessage({ id: "onboard.agent.back", defaultMessage: "Back" })}</Button> : <Button variant="ghost" onClick={onUseModels}>{intl.formatMessage({ id: "onboard.agent.useModels", defaultMessage: "Use an API model instead" })}</Button>}
      {step === "agent" ? <Button disabled={!selectedModel} onClick={() => setStep("start")}>{intl.formatMessage({ id: "onboard.agent.continue", defaultMessage: "Continue" })}</Button> : <Button disabled={!selectedModel} onClick={() => { if (selectedModel) onFinish(selectedModel); }}>{intl.formatMessage({ id: "onboard.agent.enter", defaultMessage: "Start chatting" })}</Button>}
    </div>
  </section>
  </div>;
}
