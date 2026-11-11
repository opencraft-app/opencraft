import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppServerMethodParams, AppServerMethodResult, OnboardingAgentSnapshot, OnboardingSnapshot } from "@opencraft/appserver-protocol";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsListItem, SettingsSection, SettingsSwitch } from "@opencraft/extension-react";
import { CheckIcon } from "@opencraft/design-system-web/action-icons";
import { ResetIcon } from "@opencraft/design-system-web/action-icons";
import { IconButton } from "@opencraft/design-system-web/button";
import { AgentIdentityIcon, projectAgentDirectory, type AgentCatalogModel } from "./agent-directory";
import { Button } from "./ui/button";
import "./agent-onboarding.scss";

type OnboardingMethod = "opencraft/agents/onboarding/status" | "opencraft/agents/onboarding/act" | "opencraft/agents/onboarding/models";
type OnboardingRequest = <M extends OnboardingMethod>(method: M, params: AppServerMethodParams<M>) => Promise<AppServerMethodResult<M>>;

const AGENT_NAMES: Record<string, { id: string; defaultMessage: string }> = {
  codex: { id: "onboard.agent.codex", defaultMessage: "Codex" },
  cursor: { id: "onboard.agent.cursor", defaultMessage: "Cursor" },
  claude: { id: "onboard.agent.claude", defaultMessage: "Claude Code" },
  codebuddy: { id: "onboard.agent.codebuddy", defaultMessage: "CodeBuddy" },
};

function isSnapshot(value: unknown): value is OnboardingSnapshot {
  return !!value && typeof value === "object" && Array.isArray((value as OnboardingSnapshot).agents);
}

export interface AgentOnboardingProps {
  readonly hostId: string;
  readonly request: OnboardingRequest;
  readonly presentation: "gate" | "sheet" | "settings";
  readonly onFinish?: (modelId: string) => void | Promise<void>;
  readonly onUseModels?: () => void;
  readonly onClose?: () => void;
  readonly agentPreferences?: { enabled(id: string): boolean; setEnabled(id: string, enabled: boolean): void; saving: boolean; failed: boolean };
  readonly catalogModels?: readonly AgentCatalogModel[];
  readonly onRefreshModels?: () => void;
  readonly catalogError?: boolean;
}

export function AgentOnboarding(props: AgentOnboardingProps) {
  return <AgentOnboardingContent key={props.hostId} {...props} />;
}

function AgentOnboardingContent({ hostId, request, presentation, onFinish, onUseModels, onClose, agentPreferences, catalogModels, onRefreshModels, catalogError }: AgentOnboardingProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const continueHintId = useId();
  const queryKey = ["agent-onboarding", hostId] as const;
  const [copied, setCopied] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [requestedStep, setStep] = useState<"agent" | "start">("agent");
  const [chosenAgent, setChosenAgent] = useState<string | null>(null);
  const [chosenModel, setChosenModel] = useState<{ agentId: string; id: string; name: string } | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishFailed, setFinishFailed] = useState(false);
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
  const agents = projectAgentDirectory(catalogModels ?? [], status.data?.agents ?? [], nameOf);
  const management = presentation === "settings";
  const readyAgents = agents.filter(agent => agent.ready && agentPreferences?.enabled(agent.id) !== false);
  useEffect(() => { if (chosenAgent === null && readyAgents[0]) setChosenAgent(readyAgents[0].id); }, [chosenAgent, readyAgents[0]?.id]);
  const expanded = chosenAgent;
  const expandedEntry = agents.find(agent => agent.id === expanded);
  const expandedReady = readyAgents.some(agent => agent.id === expanded);
  const agentModels = useQuery({
    queryKey: [...queryKey, "models", expanded],
    enabled: !management && expandedEntry?.native !== undefined && expandedReady,
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      const result = await request("opencraft/agents/onboarding/models", { id: expandedEntry!.native!.id });
      if (!result || !Array.isArray(result.models) || result.models.some(model => !model || typeof model.id !== "string" || !model.id || typeof model.name !== "string")) {
        throw new Error("Invalid agent models");
      }
      return result.models;
    },
  });
  const models = expandedEntry?.native ? agentModels.data ?? [] : expandedEntry?.models ?? [];
  const defaults = expandedEntry?.models;
  const defaultEntry = defaults?.find(model => model.isDefault) ?? defaults?.[0];
  const defaultModel = defaultEntry?.id;
  const selectedChoice = chosenModel?.agentId === expanded ? chosenModel : null;
  const selected = !expandedReady ? null : models.find(model => model.id === selectedChoice?.id) ?? models[0]
    ?? (!agentModels.isPending && selectedChoice?.id === defaultModel ? selectedChoice : null);
  const selectedModel = selected?.id ?? null;
  const selectedModelName = selected?.name ?? null;
  const step = requestedStep === "start" && selectedModel ? "start" : "agent";
  const refreshButton = <IconButton size="accessory" variant="ghost" aria-label={intl.formatMessage({ id: "onboard.agent.recheck", defaultMessage: "Check again" })}
    disabled={status.isFetching || finishing} onClick={() => { void status.refetch(); onRefreshModels?.(); }}><ResetIcon size={16} /></IconButton>;
  const content = <>
    {!management ? <>
      {presentation === "sheet" ? <Button variant="ghost" size="sm" disabled={finishing} onClick={onClose}>{intl.formatMessage({ id: "onboard.agent.backToSettings", defaultMessage: "Back to model settings" })}</Button> : null}
      <ol className="agent-onboard__steps">
        <li data-current={step === "agent"}>{intl.formatMessage({ id: "onboard.agent.stepAgent", defaultMessage: "1 · Agent" })}</li>
        <li data-current={step === "start"}>{intl.formatMessage({ id: "onboard.agent.stepStart", defaultMessage: "2 · Start" })}</li>
      </ol>
    </> : null}
    {!management ? <header className="agent-onboard__toolbar">
      <h2 id="agent-onboard-title">{intl.formatMessage({ id: "onboard.agent.title", defaultMessage: "Choose an agent" })}</h2>
      {refreshButton}
    </header> : null}
    {step === "start" && !management ? <p className="agent-onboard__selection">{expandedEntry?.label} · {selectedModelName}</p> : null}
    {agentPreferences?.failed ? <p role="alert">{intl.formatMessage({ id: "settings.chat.saveError", defaultMessage: "Could not save your preference. Please try again." })}</p> : null}
    {finishFailed ? <p role="alert">{intl.formatMessage({ id: "onboard.agent.startFailed", defaultMessage: "Could not start the chat. Please try again." })}</p> : null}
    {status.isPending && agents.length === 0 ? <ul className="agent-onboard__list" aria-hidden="true">
      {[0, 1, 2, 3].map(index => <li key={index} className="agent-onboard__skeleton" />)}
    </ul> : null}
    {status.isError || catalogError ? <p className="agent-onboard__note">{intl.formatMessage({ id: "settings.agents.loadFailed", defaultMessage: "Some agents could not be checked. Try checking again." })}</p> : null}
    {(step === "agent" || management) && agents.length > 0 ? <ul className="agent-onboard__list">
      {agents.map(entry => {
        const agent = entry.native;
        const activity = agent?.activity;
        const ready = entry.ready && agentPreferences?.enabled(entry.id) !== false;
        const subline = activity?.phase === "running"
          ? intl.formatMessage(activity.kind === "install"
            ? { id: "onboard.agent.installing", defaultMessage: "Installing…" }
            : { id: "onboard.agent.signingIn", defaultMessage: "Finish signing in below" })
          : activity?.phase === "failed"
            ? intl.formatMessage(activity.kind === "install"
              ? { id: "onboard.agent.installFailed", defaultMessage: "Install didn't finish" }
              : { id: "onboard.agent.signInFailed", defaultMessage: "Sign-in didn't finish" })
            : agent && !agent.installed
              ? intl.formatMessage({ id: "onboard.agent.notInstalled", defaultMessage: "Not installed" })
              : !agent || agent.authenticated === true
                ? intl.formatMessage({ id: "onboard.agent.ready", defaultMessage: "Ready" })
                : agent.authenticated === false
                  ? intl.formatMessage({ id: "onboard.agent.signInNeeded", defaultMessage: "Not signed in" })
                  : intl.formatMessage({ id: "onboard.agent.unknown", defaultMessage: "Couldn't check this agent" });
        return <li key={entry.id} data-agent={agent?.id ?? entry.id} data-selected={!management && expanded === entry.id}>
          <SettingsListItem label={entry.label} description={subline} icon={<AgentIdentityIcon id={entry.id} />}
            actions={<span className="agent-onboard__actions">
              {agentPreferences ? <SettingsSwitch label={entry.label} checked={entry.ready && agentPreferences.enabled(entry.id)} disabled={!entry.ready || agentPreferences.saving || finishing} onCheckedChange={checked => agentPreferences.setEnabled(entry.id, checked)} /> : null}
              {ready && !management ? <Button size="sm" variant="ghost" aria-expanded={expanded === entry.id} aria-controls={`agent-models-${entry.id}`} onClick={() => setChosenAgent(entry.id)}>
                {intl.formatMessage({ id: "onboard.agent.chooseModels", defaultMessage: "Choose models" })}
              </Button> : null}
              {agent && activity?.phase === "running" ? <Button size="sm" variant="ghost" disabled={pendingId === agent.id} onClick={() => { void run(agent!.id, "cancel"); }}>
                {intl.formatMessage({ id: "onboard.agent.cancel", defaultMessage: "Cancel" })}
              </Button> : null}
              {agent && activity?.phase === "failed" ? <Button size="sm" variant="outline" disabled={pendingId === agent.id} onClick={() => { void run(agent!.id, activity.kind); }}>
                {intl.formatMessage({ id: "onboard.agent.retry", defaultMessage: "Retry" })}
              </Button> : null}
              {agent && !activity && !agent.installed ? <Button size="sm" variant="outline" disabled={pendingId === agent.id} onClick={() => {
                if (agent.canInstallPackage) void run(agent!.id, "install");
                else window.open(agent.installUrl, "_blank", "noopener,noreferrer");
              }}>
                {intl.formatMessage({ id: "onboard.agent.install", defaultMessage: "Install" })}
              </Button> : null}
              {agent && !activity && agent.installed && agent.authenticated === false ? <Button size="sm" disabled={pendingId === agent.id} onClick={() => { void run(agent!.id, "sign-in"); }}>
                {intl.formatMessage({ id: "onboard.agent.signIn", defaultMessage: "Sign in" })}
              </Button> : null}
            </span>} />
          {ready && !management && expanded === entry.id ? <div className="agent-onboard__models" id={`agent-models-${entry.id}`}>
            {expandedEntry?.native && agentModels.isPending ? <p role="status">{intl.formatMessage({ id: "onboard.agent.modelsLoading", defaultMessage: "Reading this agent's models…" })}</p> : null}
            {expandedEntry?.native && (agentModels.isError || (agentModels.isSuccess && models.length === 0)) ? <>
              <p role="status">{defaultEntry?.isDefault ? intl.formatMessage({ id: "onboard.agent.modelsFailed", defaultMessage: "Couldn't read this agent's models. You can still continue with its default." }) : intl.formatMessage({ id: "composer.model.failedTitle", defaultMessage: "Couldn't load models" })}</p>
              <div className="agent-onboard__model-actions">
                <Button size="sm" variant="ghost" disabled={agentModels.isFetching} onClick={() => { void agentModels.refetch(); }}>{intl.formatMessage({ id: "onboard.agent.retry", defaultMessage: "Retry" })}</Button>
                {defaultModel ? <Button size="sm" variant="outline" aria-pressed={selectedModel === defaultModel} onClick={() => setChosenModel({ agentId: entry.id, id: defaultModel, name: defaultEntry?.name ?? entry.label })}>{defaultEntry?.isDefault ? intl.formatMessage({ id: "onboard.agent.useDefault", defaultMessage: "Use the default model" }) : defaultEntry?.name}</Button> : null}
              </div>
            </> : null}
            {models.length > 0 ? <ul>
              {models.map(model => <li key={model.id}>
                <Button size="sm" variant={selectedModel === model.id ? "outline" : "ghost"} contentLayout="row" aria-pressed={selectedModel === model.id} onClick={() => setChosenModel({ agentId: entry.id, ...model })}>
                  {model.name}{selectedModel === model.id ? <CheckIcon size={14} aria-hidden="true" /> : null}
                </Button>
              </li>)}
            </ul> : null}
          </div> : null}
          {activity?.kind === "sign-in" ? <div className="agent-onboard__guide">
            {activity.url ? <a href={activity.url} target="_blank" rel="noreferrer">{intl.formatMessage({ id: "onboard.agent.openLogin", defaultMessage: "Open sign-in page" })}</a> : <span>{intl.formatMessage({ id: "onboard.agent.waiting", defaultMessage: "Waiting for the sign-in link…" })}</span>}
            {activity.userCode ? <span className="agent-onboard__code">
              <code>{activity.userCode}</code>
              <button type="button" onClick={() => { void copyCode(agent!.id, activity.userCode!); }}>
                {copied === agent!.id
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
    {!management ? <div className="agent-onboard__footer">
      {step === "start" ? <Button variant="ghost" disabled={finishing} onClick={() => setStep("agent")}>{intl.formatMessage({ id: "onboard.agent.back", defaultMessage: "Back" })}</Button> : <Button variant="ghost" disabled={finishing} onClick={onUseModels}>{intl.formatMessage({ id: "onboard.agent.useModels", defaultMessage: "Skip for now" })}</Button>}
      <div className="agent-onboard__continue">
      {step === "agent" ? <Button aria-describedby={!selectedModel ? continueHintId : undefined} disabled={!selectedModel || agentPreferences?.saving || finishing} onClick={() => setStep("start")}>{intl.formatMessage({ id: "onboard.agent.continue", defaultMessage: "Continue" })}</Button> : <Button disabled={!selectedModel || agentPreferences?.saving || finishing} onClick={() => {
        if (!selectedModel || !expandedReady) return;
        setFinishing(true); setFinishFailed(false);
        void Promise.resolve().then(() => onFinish?.(selectedModel)).catch(() => setFinishFailed(true)).finally(() => setFinishing(false));
      }}>{intl.formatMessage({ id: "onboard.agent.enter", defaultMessage: "Start chatting" })}</Button>}
      {step === "agent" && !selectedModel ? <p id={continueHintId} className="agent-onboard__continue-hint">{intl.formatMessage({ id: "onboard.agent.chooseModelHint", defaultMessage: "Choose an enabled agent and model to continue." })}</p> : null}
      </div>
    </div> : null}
  </>;
  if (management) return <SettingsSection title={intl.formatMessage({ id: "composer.agent.label", defaultMessage: "Agent" })} action={refreshButton} actionAlignment="center">
    {content}
  </SettingsSection>;
  return <div className={presentation === "sheet" ? "agent-onboard-gate agent-onboard-gate--sheet" : "agent-onboard-gate"} role="dialog" aria-modal={presentation === "gate"} aria-labelledby="agent-onboard-title">
    <section className="agent-onboard" aria-labelledby="agent-onboard-title">{content}</section>
  </div>;
}
