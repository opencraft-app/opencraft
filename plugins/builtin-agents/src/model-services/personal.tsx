import { useEffect, useRef, useState, type ComponentType } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  SettingsButton,
  SettingsNotice,
  SettingsPageHeader,
  SettingsSelect,
  SettingsSwitch,
  SettingsTextInput,
  type ExtensionSettingsViewProps,
} from "@opencraft/extension-react";
import { BrandMark } from "./brand-mark";
import { NavigationList, NavigationItem } from "@opencraft/design-system-web/navigation";
import { useIntl } from "@opencraft/i18n/react";

export interface PersonalModelConnection {
  kind?: "subscription" | "api-key" | "platform";
  id: string;
  name: string;
  baseUrl: string;
  protocol: string;
  enabled: boolean;
  owned: boolean;
  scope: "personal" | "team";
  revision: number;
  template: boolean;
  models: { id: string; name: string; enabled: boolean }[];
}
export interface PersonalModelsDocument {
  subscriptionAvailable?: boolean;
  actor: string;
  period: string;
  usedTokens: number;
  heldTokens: number;
  canManage: boolean;
  limit: { monthlyTokens: number; requestTokens: number; concurrency: number } | null;
  personalLimit: { monthlyTokens: number | null; revision: number };
  directory: PersonalModelConnection[];
}
const path = "/__opencraft_model_gateway";
type Message = { readonly id: string; readonly defaultMessage: string };
const errors: Record<string, Message> = {
  gateway_revision_conflict: {
    id: "modelServices.personal.error.revisionConflict",
    defaultMessage: "Settings were changed elsewhere. Refresh and try again; your input has been kept.",
  },
  gateway_identity_changed: {
    id: "modelServices.personal.error.identityChanged",
    defaultMessage: "Your sign-in changed. Reopen settings.",
  },
  gateway_endpoint_not_approved: {
    id: "modelServices.personal.error.endpointNotApproved",
    defaultMessage: "This service or model is no longer available. Choose again.",
  },
  gateway_contribution_forbidden: {
    id: "modelServices.personal.error.contributionForbidden",
    defaultMessage: "This connection can't be changed. Refresh and try again.",
  },
  gateway_sharing_consent_required: {
    id: "modelServices.personal.error.sharingConsentRequired",
    defaultMessage: "Confirm whether others may use your quota.",
  },
};
const readFailed: Message = {
  id: "modelServices.personal.error.readFailed",
  defaultMessage: "Couldn't load my models. Try again later.",
};
const documentUnavailable: Message = {
  id: "modelServices.personal.error.unavailable",
  defaultMessage: "My models are unavailable right now.",
};
const saveFailed: Message = {
  id: "modelServices.personal.error.saveFailed",
  defaultMessage: "Couldn't save. Check your input and try again.",
};
const messages = {
  errorIdentityRecheck: {
    id: "modelServices.personal.error.identityRecheck",
    defaultMessage: "Your sign-in changed. Review the settings again.",
  },
  statusSubscriptionConnected: {
    id: "modelServices.personal.status.subscriptionConnected",
    defaultMessage: "Subscription connected",
  },
  statusAwaitingSignIn: {
    id: "modelServices.personal.status.awaitingSignIn",
    defaultMessage: "Waiting for you to finish signing in",
  },
  statusSaved: { id: "modelServices.personal.status.saved", defaultMessage: "Saved" },
  errorSignInIncomplete: {
    id: "modelServices.personal.error.signInIncomplete",
    defaultMessage: "Sign-in didn't complete. Sign in again.",
  },
  errorSignInExpired: {
    id: "modelServices.personal.error.signInExpired",
    defaultMessage: "Sign-in expired. Sign in again.",
  },
  onlyMe: { id: "modelServices.availability.onlyMe", defaultMessage: "Only me" },
  shared: { id: "modelServices.personal.shared", defaultMessage: "Shared" },
  platformProvided: { id: "modelServices.personal.platformProvided", defaultMessage: "Provided by the platform" },
  backToMine: { id: "modelServices.personal.backToMine", defaultMessage: "Back to my models" },
  title: { id: "modelServices.personal.title", defaultMessage: "Model services" },
  connections: { id: "modelServices.personal.connections", defaultMessage: "Model connections" },
  search: { id: "modelServices.personal.search", defaultMessage: "Search connections" },
  addConnection: { id: "modelServices.personal.addConnection", defaultMessage: "Add my connection" },
  add: { id: "modelServices.personal.add", defaultMessage: "Add" },
  myModels: { id: "modelServices.personal.myModels", defaultMessage: "My models" },
  noOwnedConnections: {
    id: "modelServices.personal.noOwnedConnections",
    defaultMessage: "You haven't added any connections yet",
  },
  platformModels: { id: "modelServices.personal.platformModels", defaultMessage: "Platform models" },
  managePlatform: { id: "modelServices.personal.managePlatform", defaultMessage: "Manage platform connections" },
  selectConnection: { id: "modelServices.personal.selectConnection", defaultMessage: "Select a connection" },
  loading: { id: "modelServices.personal.loading", defaultMessage: "Loading model connections…" },
  retry: { id: "common.retry", defaultMessage: "Try again" },
  connectionMethod: { id: "modelServices.personal.connectionMethod", defaultMessage: "Connection method" },
  methodApiKey: { id: "modelServices.personal.method.apiKey", defaultMessage: "Enter an API key" },
  methodSubscription: {
    id: "modelServices.personal.method.subscription",
    defaultMessage: "Sign in to a Codex subscription",
  },
  subscriptionTitle: { id: "modelServices.personal.subscription.title", defaultMessage: "My Codex subscription" },
  subscriptionHint: {
    id: "modelServices.personal.subscription.hint",
    defaultMessage: "Only you and assistants working for you can use it. Available quota is set by the provider.",
  },
  subscriptionEnterCode: {
    id: "modelServices.personal.subscription.enterCode",
    defaultMessage: "Open the sign-in page and enter the code: ",
  },
  subscriptionOpenSignIn: { id: "modelServices.personal.subscription.openSignIn", defaultMessage: "Open sign-in page" },
  subscriptionAutoConnect: {
    id: "modelServices.personal.subscription.autoConnect",
    defaultMessage: "You'll be connected automatically after you sign in.",
  },
  cancel: { id: "common.cancel", defaultMessage: "Cancel" },
  subscriptionSignInAndConnect: {
    id: "modelServices.personal.subscription.signInAndConnect",
    defaultMessage: "Sign in and connect",
  },
  name: { id: "modelServices.personal.name", defaultMessage: "Name" },
  namePlaceholder: { id: "modelServices.personal.namePlaceholder", defaultMessage: "For example: My coding model" },
  service: { id: "modelServices.personal.service", defaultMessage: "Service" },
  model: { id: "modelServices.personal.model", defaultMessage: "Model" },
  apiKey: { id: "modelServices.personal.apiKey", defaultMessage: "API key" },
  availability: { id: "modelServices.availability.label", defaultMessage: "Available to" },
  scopePersonalHint: {
    id: "modelServices.personal.scope.personalHint",
    defaultMessage: "You and assistants working for you can use it; other people's tasks can't.",
  },
  save: { id: "common.save", defaultMessage: "Save" },
  connectionSettings: { id: "modelServices.personal.connectionSettings", defaultMessage: "Connection settings" },
  configured: { id: "modelServices.personal.configured", defaultMessage: "Connection configured" },
  enabled: { id: "modelServices.personal.enabled", defaultMessage: "Enabled" },
  disabled: { id: "modelServices.personal.disabled", defaultMessage: "Not enabled" },
  scopeTeam: { id: "modelServices.personal.scope.team", defaultMessage: "Users of this platform" },
  change: { id: "modelServices.personal.change", defaultMessage: "Change" },
  scopeTitle: { id: "modelServices.personal.scope.title", defaultMessage: "Who can use this" },
  scopeLabel: { id: "modelServices.personal.scope.label", defaultMessage: "Usage scope" },
  scopeTeamHint: {
    id: "modelServices.personal.scope.teamHint",
    defaultMessage:
      "Others can also choose this connection. Upstream API charges are still billed to the account that owns your key.",
  },
  scopeAllowOthers: { id: "modelServices.personal.scope.allowOthers", defaultMessage: "Allow others to use it" },
  modelList: { id: "modelServices.personal.modelList", defaultMessage: "Model list" },
  models: { id: "modelServices.personal.models", defaultMessage: "Models" },
  available: { id: "modelServices.personal.available", defaultMessage: "Available" },
  advanced: { id: "modelServices.personal.advanced", defaultMessage: "Advanced settings" },
  serviceUrl: { id: "modelServices.personal.serviceUrl", defaultMessage: "Service URL" },
  subscriptionMethod: {
    id: "modelServices.personal.subscription.method",
    defaultMessage: "Subscription sign-in · Only me",
  },
  withdrawTitle: { id: "modelServices.personal.withdraw.title", defaultMessage: "Disable connection" },
  withdrawHint: {
    id: "modelServices.personal.withdraw.hint",
    defaultMessage: "Stops future calls. Requests already sent will still be billed.",
  },
  withdrawAction: { id: "modelServices.personal.withdraw.action", defaultMessage: "Disable" },
  empty: { id: "modelServices.personal.empty", defaultMessage: "No model services are available right now." },
  usageLabel: { id: "modelServices.personal.usage.label", defaultMessage: "My usage" },
  usageTitle: { id: "modelServices.personal.usage.title", defaultMessage: "My connection usage" },
  usageThisMonth: { id: "modelServices.personal.usage.thisMonth", defaultMessage: "Used this month" },
  usageTokens: { id: "modelServices.personal.usage.tokens", defaultMessage: "{count} tokens" },
  usageHeld: { id: "modelServices.personal.usage.held", defaultMessage: "Processing or awaiting confirmation" },
  limitTitle: { id: "modelServices.personal.limit.title", defaultMessage: "Usage limit" },
  limitHint: {
    id: "modelServices.personal.limit.hint",
    defaultMessage: "Limits future requests by tokens, not by cost. A single request may exceed the reserved amount.",
  },
  limitUnconfigured: {
    id: "modelServices.personal.limit.unconfigured",
    defaultMessage: "The platform hasn't set a quota yet",
  },
  limitMonthly: { id: "modelServices.personal.limit.monthly", defaultMessage: "{count} tokens / month" },
  limitMonthlyMaximum: { id: "modelServices.personal.limit.monthlyMaximum", defaultMessage: "Monthly maximum" },
  limitSave: { id: "modelServices.personal.limit.save", defaultMessage: "Save limit" },
  refresh: { id: "common.refresh", defaultMessage: "Refresh" },
  saving: { id: "modelServices.personal.saving", defaultMessage: "Saving…" },
} as const;
/** Carries a message descriptor so the view can format it in the active locale. */
class PersonalModelsError extends Error {
  constructor(readonly descriptor: Message) {
    super(descriptor.defaultMessage);
  }
}
export async function readPersonalModels(fetcher: typeof fetch = globalThis.fetch): Promise<PersonalModelsDocument> {
  const response = await fetcher(path, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new PersonalModelsError(readFailed);
  const document = await response.json();
  if (typeof document.actor !== "string" || !Array.isArray(document.directory) || !document.personalLimit)
    throw new PersonalModelsError(documentUnavailable);
  return document;
}
export function createPersonalModelServicesView(
  fetcher: typeof fetch = globalThis.fetch,
  PlatformView?: ComponentType<ExtensionSettingsViewProps>,
) {
  return function PersonalModelServicesView(_props: ExtensionSettingsViewProps) {
    const intl = useIntl();
    const failure = (e: unknown) =>
      e instanceof PersonalModelsError ? intl.formatMessage(e.descriptor) : (e as Error).message;
    const [managePlatform, setManagePlatform] = useState(false);
    const [doc, setDoc] = useState<PersonalModelsDocument | null>(null),
      [selected, setSelected] = useState<string | null>(null);
    const [adding, setAdding] = useState(false),
      [name, setName] = useState(""),
      [templateId, setTemplateId] = useState(""),
      [modelId, setModelId] = useState(""),
      [key, setKey] = useState("");
    const [busy, setBusy] = useState(false),
      [error, setError] = useState(""),
      [message, setMessage] = useState(""),
      [query, setQuery] = useState("");
    const [scopeOpen, setScopeOpen] = useState(false),
      [scope, setScope] = useState<"personal" | "team">("personal"),
      [consent, setConsent] = useState(false);
    const [connectionType, setConnectionType] = useState("api-key");
    const [login, setLogin] = useState<{
      sessionId: string;
      verificationUrl: string;
      userCode: string;
      expiresAt: number;
    } | null>(null);
    const [limitDraft, setLimitDraft] = useState(""),
      [limitOpen, setLimitOpen] = useState(false);
    const lifetime = useRef(0),
      identity = useRef<string | null>(null),
      pending = useRef(false);
    const apply = (next: PersonalModelsDocument) => {
      if (identity.current !== null && identity.current !== next.actor) {
        setLogin(null);
        setKey("");
        setName("");
        setAdding(false);
        setSelected(null);
        setScopeOpen(false);
        setLimitOpen(false);
      }
      identity.current = next.actor;
      setDoc(next);
    };
    const refresh = async () => {
      const epoch = lifetime.current;
      try {
        const next = await readPersonalModels(fetcher);
        if (epoch === lifetime.current) {
          apply(next);
          setError("");
        }
      } catch (e) {
        if (epoch === lifetime.current) setError(failure(e));
      }
    };
    useEffect(() => {
      void refresh();
      return () => {
        lifetime.current++;
      };
    }, []);
    const write = async (body: Record<string, unknown>, success?: (result: any) => void) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      setError("");
      setMessage("");
      const epoch = lifetime.current,
        actor = identity.current;
      try {
        const response = await fetcher(path, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = await response.json();
        if (!response.ok) throw new PersonalModelsError(errors[result.error] ?? saveFailed);
        const next = await readPersonalModels(fetcher);
        if (epoch !== lifetime.current) return;
        apply(next);
        if (next.actor !== actor) {
          setError(intl.formatMessage(messages.errorIdentityRecheck));
          return;
        }
        success?.(result);
        setMessage(
          body.action === "subscription"
            ? result.status === "complete"
              ? intl.formatMessage(messages.statusSubscriptionConnected)
              : result.status === "pending"
                ? intl.formatMessage(messages.statusAwaitingSignIn)
                : ""
            : intl.formatMessage(messages.statusSaved),
        );
      } catch (e) {
        if (epoch === lifetime.current) setError(failure(e));
      } finally {
        pending.current = false;
        if (epoch === lifetime.current) setBusy(false);
      }
    };
    const subscriptionResult = (result: any) => {
      if (result.status === "complete") {
        setLogin(null);
        setSelected(result.providerId);
        setAdding(false);
      } else if (result.login) setLogin(result.login);
      else if (result.status === "error") {
        setLogin(null);
        setError(intl.formatMessage(messages.errorSignInIncomplete));
      }
    };
    useEffect(() => {
      if (!login) return;
      const timer = setInterval(() => {
        if (Date.now() >= login.expiresAt) {
          setLogin(null);
          setError(intl.formatMessage(messages.errorSignInExpired));
          return;
        }
        void write({ action: "subscription", operation: "poll", sessionId: login.sessionId }, subscriptionResult);
      }, 3000);
      return () => clearInterval(timer);
    }, [login]);
    const connections = doc?.directory ?? [],
      templates = connections.filter((c) => c.template && c.models.length);
    const connection = connections.find((c) => c.id === selected) ?? connections.find((c) => c.owned) ?? connections[0];
    const template = templates.find((c) => c.id === templateId) ?? templates[0],
      model = template?.models.find((m) => m.id === modelId) ?? template?.models[0];
    const visible = connections.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
    const pick = (id: string) => {
      setSelected(id);
      setAdding(false);
      setScopeOpen(false);
      setError("");
      setMessage("");
    };
    const add = () => {
      setAdding(true);
      setScopeOpen(false);
      setError("");
      setMessage("");
    };
    const row = (c: PersonalModelConnection) => (
      <NavigationItem
        key={c.id}
        className="model-services-personal__connection"
        aria-current={!adding && connection?.id === c.id ? "page" : undefined}
        onClick={() => pick(c.id)}
      >
        <BrandMark kind="provider" id={c.id} size={24} />
        <span>
          {c.name}
          <small>
            {c.owned
              ? c.scope === "personal"
                ? intl.formatMessage(messages.onlyMe)
                : intl.formatMessage(messages.shared)
              : intl.formatMessage(messages.platformProvided)}
          </small>
        </span>
      </NavigationItem>
    );
    if (managePlatform && doc?.canManage && PlatformView)
      return (
        <div className="model-services-personal__platform">
          <SettingsButton variant="quiet" onClick={() => setManagePlatform(false)}>
            {intl.formatMessage(messages.backToMine)}
          </SettingsButton>
          <PlatformView {..._props} />
        </div>
      );
    return (
      <div className="model-services">
        <SettingsPageHeader title={intl.formatMessage(messages.title)} />
        <aside className="model-services__navigation" aria-label={intl.formatMessage(messages.connections)}>
          <div className="model-services__search">
            <SettingsTextInput
              aria-label={intl.formatMessage(messages.search)}
              placeholder={intl.formatMessage(messages.search)}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <SettingsButton
              aria-label={intl.formatMessage(messages.addConnection)}
              disabled={!doc || busy || (!templates.length && !doc.subscriptionAvailable)}
              onClick={add}
            >
              {intl.formatMessage(messages.add)}
            </SettingsButton>
          </div>
          <details open>
            <summary className="ui-native-disclosure">{intl.formatMessage(messages.myModels)}</summary>
            <NavigationList label={intl.formatMessage(messages.myModels)}>
              {visible.filter((c) => c.owned).map(row)}
            </NavigationList>
            {doc && !connections.some((c) => c.owned) ? (
              <p className="model-services__muted">{intl.formatMessage(messages.noOwnedConnections)}</p>
            ) : null}
          </details>
          <details open>
            <summary className="ui-native-disclosure">{intl.formatMessage(messages.platformProvided)}</summary>
            <NavigationList label={intl.formatMessage(messages.platformModels)}>
              {visible.filter((c) => !c.owned).map(row)}
            </NavigationList>
          </details>
          {doc?.canManage && PlatformView ? (
            <SettingsButton variant="quiet" disabled={busy} onClick={() => setManagePlatform(true)}>
              {intl.formatMessage(messages.managePlatform)}
            </SettingsButton>
          ) : null}
        </aside>
        <div className="model-services__main">
          <div className="model-services__mobile-select">
            <SettingsSelect
              aria-label={intl.formatMessage(messages.selectConnection)}
              value={adding ? "" : (connection?.id ?? "")}
              onChange={(e) => pick(e.target.value)}
            >
              <option value="">{intl.formatMessage(messages.selectConnection)}</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SettingsSelect>
            <SettingsButton
              aria-label={intl.formatMessage(messages.addConnection)}
              disabled={!doc || busy || (!templates.length && !doc.subscriptionAvailable)}
              onClick={add}
            >
              {intl.formatMessage(messages.add)}
            </SettingsButton>
          </div>
          <div className="model-services__detail">
            {!doc ? (
              <SettingsNotice>
                {error || intl.formatMessage(messages.loading)}
                <SettingsButton disabled={busy} onClick={() => void refresh()}>
                  {intl.formatMessage(messages.retry)}
                </SettingsButton>
              </SettingsNotice>
            ) : null}
            {doc && adding ? (
              <section className="model-services__config" aria-label={intl.formatMessage(messages.addConnection)}>
                <header>
                  <h2>{intl.formatMessage(messages.addConnection)}</h2>
                </header>
                {doc.subscriptionAvailable ? (
                  <div className="model-services__row">
                    <label htmlFor="personal-model-type">{intl.formatMessage(messages.connectionMethod)}</label>
                    <SettingsSelect
                      id="personal-model-type"
                      value={connectionType}
                      disabled={busy || !!login}
                      onChange={(e) => setConnectionType(e.target.value)}
                    >
                      <option value="api-key">{intl.formatMessage(messages.methodApiKey)}</option>
                      <option value="subscription">{intl.formatMessage(messages.methodSubscription)}</option>
                    </SettingsSelect>
                  </div>
                ) : null}
                {connectionType === "subscription" && doc.subscriptionAvailable ? (
                  <>
                    <div className="model-services__row">
                      <div>
                        <label>{intl.formatMessage(messages.subscriptionTitle)}</label>
                        <p>{intl.formatMessage(messages.subscriptionHint)}</p>
                      </div>
                    </div>
                    {login ? (
                      <SettingsNotice>
                        <p>
                          {intl.formatMessage(messages.subscriptionEnterCode)}
                          <strong>{login.userCode}</strong>
                        </p>
                        <a href={login.verificationUrl} target="_blank" rel="noopener noreferrer">
                          {intl.formatMessage(messages.subscriptionOpenSignIn)}
                        </a>
                        <p>{intl.formatMessage(messages.subscriptionAutoConnect)}</p>
                      </SettingsNotice>
                    ) : null}
                    <div className="model-services__connection-actions">
                      <SettingsButton
                        disabled={busy}
                        onClick={() => {
                          if (login)
                            void write(
                              { action: "subscription", operation: "cancel", sessionId: login.sessionId },
                              () => {
                                setLogin(null);
                                setAdding(false);
                              },
                            );
                          else setAdding(false);
                        }}
                      >
                        {intl.formatMessage(messages.cancel)}
                      </SettingsButton>
                      <SettingsButton
                        variant="primary"
                        disabled={busy || !!login}
                        onClick={() => void write({ action: "subscription", operation: "start" }, subscriptionResult)}
                      >
                        {intl.formatMessage(messages.subscriptionSignInAndConnect)}
                      </SettingsButton>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="model-services__row">
                      <label htmlFor="personal-model-name">{intl.formatMessage(messages.name)}</label>
                      <SettingsTextInput
                        id="personal-model-name"
                        value={name}
                        disabled={busy}
                        placeholder={intl.formatMessage(messages.namePlaceholder)}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </div>
                    <div className="model-services__row">
                      <label htmlFor="personal-model-service">{intl.formatMessage(messages.service)}</label>
                      <SettingsSelect
                        id="personal-model-service"
                        disabled={busy}
                        value={template?.id ?? ""}
                        onChange={(e) => {
                          setTemplateId(e.target.value);
                          setModelId("");
                          setKey("");
                        }}
                      >
                        {templates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </SettingsSelect>
                    </div>
                    <div className="model-services__row">
                      <label htmlFor="personal-model-model">{intl.formatMessage(messages.model)}</label>
                      <SettingsSelect
                        id="personal-model-model"
                        disabled={busy}
                        value={model?.id ?? ""}
                        onChange={(e) => setModelId(e.target.value)}
                      >
                        {template?.models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </SettingsSelect>
                    </div>
                    <div className="model-services__row">
                      <div>
                        <label htmlFor="personal-model-key">{intl.formatMessage(messages.apiKey)}</label>
                        <p>{template?.baseUrl}</p>
                      </div>
                      <SettingsTextInput
                        id="personal-model-key"
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        value={key}
                        disabled={busy}
                        onChange={(e) => setKey(e.target.value)}
                      />
                    </div>
                    <div className="model-services__row">
                      <div>
                        <label>{intl.formatMessage(messages.availability)}</label>
                        <p>{intl.formatMessage(messages.scopePersonalHint)}</p>
                      </div>
                      <span>{intl.formatMessage(messages.onlyMe)}</span>
                    </div>
                    <div className="model-services__connection-actions">
                      <SettingsButton
                        disabled={busy}
                        onClick={() => {
                          setAdding(false);
                          setKey("");
                        }}
                      >
                        {intl.formatMessage(messages.cancel)}
                      </SettingsButton>
                      <SettingsButton
                        variant="primary"
                        disabled={busy || !name.trim() || !key.trim() || !template || !model}
                        onClick={() =>
                          void write(
                            {
                              action: "contribute",
                              name,
                              apiKey: key,
                              baseUrl: template!.baseUrl,
                              protocol: template!.protocol,
                              model: model!.id,
                              scope: "personal",
                            },
                            (result) => {
                              setKey("");
                              setName("");
                              setSelected(result.providerId);
                              setAdding(false);
                            },
                          )
                        }
                      >
                        {intl.formatMessage(messages.save)}
                      </SettingsButton>
                    </div>
                  </>
                )}
              </section>
            ) : doc && connection ? (
              <>
                <section
                  className="model-services__config"
                  aria-label={intl.formatMessage(messages.connectionSettings)}
                >
                  <header>
                    <BrandMark kind="provider" id={connection.id} size={24} />
                    <h2>{connection.name}</h2>
                  </header>
                  <div className="model-services__connection-summary">
                    <span>
                      {connection.owned
                        ? intl.formatMessage(messages.configured)
                        : intl.formatMessage(messages.platformProvided)}{" "}
                      ·{" "}
                      {connection.enabled
                        ? intl.formatMessage(messages.enabled)
                        : intl.formatMessage(messages.disabled)}
                    </span>
                  </div>
                  {connection.owned ? (
                    <div className="model-services__row">
                      <div>
                        <label>{intl.formatMessage(messages.availability)}</label>
                        {connection.scope === "personal" ? (
                          <p>{intl.formatMessage(messages.scopePersonalHint)}</p>
                        ) : null}
                      </div>
                      <div className="model-services__row-end">
                        <span>
                          {connection.scope === "personal"
                            ? intl.formatMessage(messages.onlyMe)
                            : intl.formatMessage(messages.scopeTeam)}
                        </span>
                        {connection.kind !== "subscription" ? (
                          <Popover.Root
                            open={scopeOpen}
                            onOpenChange={(open) => {
                              if (busy) return;
                              setScopeOpen(open);
                              if (open) {
                                setScope(connection.scope);
                                setConsent(false);
                              }
                            }}
                          >
                            <Popover.Trigger asChild>
                              <SettingsButton variant="quiet" disabled={busy}>
                                {intl.formatMessage(messages.change)}
                              </SettingsButton>
                            </Popover.Trigger>
                            <Popover.Portal>
                              <Popover.Content
                                className="model-services-actions model-services-personal__scope"
                                align="end"
                                sideOffset={6}
                                collisionPadding={12}
                                aria-label={intl.formatMessage(messages.scopeTitle)}
                              >
                                <strong>{intl.formatMessage(messages.scopeTitle)}</strong>
                                <SettingsSelect
                                  aria-label={intl.formatMessage(messages.scopeLabel)}
                                  value={scope}
                                  disabled={busy}
                                  onChange={(e) => {
                                    setScope(e.target.value as "personal" | "team");
                                    setConsent(false);
                                  }}
                                >
                                  <option value="personal">{intl.formatMessage(messages.onlyMe)}</option>
                                  <option value="team">{intl.formatMessage(messages.scopeTeam)}</option>
                                </SettingsSelect>
                                {scope === "team" ? (
                                  <>
                                    <p>{intl.formatMessage(messages.scopeTeamHint)}</p>
                                    <div className="model-services__row">
                                      <span>{intl.formatMessage(messages.scopeAllowOthers)}</span>
                                      <SettingsSwitch
                                        label={intl.formatMessage(messages.scopeAllowOthers)}
                                        checked={consent}
                                        disabled={busy}
                                        onCheckedChange={setConsent}
                                      />
                                    </div>
                                  </>
                                ) : (
                                  <p>{intl.formatMessage(messages.scopePersonalHint)}</p>
                                )}
                                <div className="model-services__connection-actions">
                                  <SettingsButton disabled={busy} onClick={() => setScopeOpen(false)}>
                                    {intl.formatMessage(messages.cancel)}
                                  </SettingsButton>
                                  <SettingsButton
                                    variant="primary"
                                    disabled={busy || scope === connection.scope || (scope === "team" && !consent)}
                                    onClick={() =>
                                      void write(
                                        {
                                          action: "scope",
                                          provider: connection.id,
                                          scope,
                                          revision: connection.revision,
                                          shareWithTeam: scope === "team",
                                        },
                                        () => setScopeOpen(false),
                                      )
                                    }
                                  >
                                    {intl.formatMessage(messages.save)}
                                  </SettingsButton>
                                </div>
                                {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
                              </Popover.Content>
                            </Popover.Portal>
                          </Popover.Root>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </section>
                <section className="model-services__models" aria-label={intl.formatMessage(messages.modelList)}>
                  <div className="model-services__model-heading">
                    <h3>{intl.formatMessage(messages.models)}</h3>
                  </div>
                  {connection.models.map((m) => (
                    <div className="model-services__model" key={m.id}>
                      <BrandMark kind="model" id={m.id} size={32} />
                      <div>
                        <strong>{m.name}</strong>
                        <small>{m.id}</small>
                      </div>
                      <span>
                        {connection.enabled && m.enabled
                          ? intl.formatMessage(messages.available)
                          : intl.formatMessage(messages.disabled)}
                      </span>
                    </div>
                  ))}
                </section>
                <details className="model-services__advanced">
                  <summary className="ui-native-disclosure">{intl.formatMessage(messages.advanced)}</summary>
                  <div className="model-services__row">
                    <span>
                      {connection.kind === "subscription"
                        ? intl.formatMessage(messages.connectionMethod)
                        : intl.formatMessage(messages.serviceUrl)}
                    </span>
                    <span>
                      {connection.kind === "subscription"
                        ? intl.formatMessage(messages.subscriptionMethod)
                        : connection.baseUrl}
                    </span>
                  </div>
                  {connection.owned ? (
                    <div className="model-services__row">
                      <div>
                        <label>{intl.formatMessage(messages.withdrawTitle)}</label>
                        <p>{intl.formatMessage(messages.withdrawHint)}</p>
                      </div>
                      <SettingsButton
                        disabled={busy}
                        onClick={() =>
                          void write({ action: "withdraw", provider: connection.id }, () => setSelected(null))
                        }
                      >
                        {intl.formatMessage(messages.withdrawAction)}
                      </SettingsButton>
                    </div>
                  ) : null}
                </details>
              </>
            ) : doc ? (
              <SettingsNotice>{intl.formatMessage(messages.empty)}</SettingsNotice>
            ) : null}
            {doc && !adding ? (
              <section className="model-services__config" aria-label={intl.formatMessage(messages.usageLabel)}>
                <header>
                  <h3>{intl.formatMessage(messages.usageTitle)}</h3>
                </header>
                <div className="model-services__row">
                  <span>{intl.formatMessage(messages.usageThisMonth)}</span>
                  <span className="model-services__row-end">
                    {intl.formatMessage(messages.usageTokens, { count: doc.usedTokens.toLocaleString() })}
                  </span>
                </div>
                {doc.heldTokens > 0 ? (
                  <div className="model-services__row">
                    <span>{intl.formatMessage(messages.usageHeld)}</span>
                    <span className="model-services__row-end">
                      {intl.formatMessage(messages.usageTokens, { count: doc.heldTokens.toLocaleString() })}
                    </span>
                  </div>
                ) : null}
                <div className="model-services__row">
                  <div>
                    <label>{intl.formatMessage(messages.limitTitle)}</label>
                    <p>{intl.formatMessage(messages.limitHint)}</p>
                  </div>
                  <div className="model-services__row-end">
                    <span>
                      {doc.limit
                        ? intl.formatMessage(messages.limitMonthly, {
                            count: Math.min(
                              doc.limit.monthlyTokens,
                              doc.personalLimit.monthlyTokens ?? Infinity,
                            ).toLocaleString(),
                          })
                        : intl.formatMessage(messages.limitUnconfigured)}
                    </span>
                    <SettingsButton
                      variant="quiet"
                      disabled={busy || !doc.limit}
                      onClick={() => {
                        setLimitDraft(String(doc.personalLimit.monthlyTokens ?? doc.limit?.monthlyTokens ?? 0));
                        setLimitOpen(!limitOpen);
                      }}
                    >
                      {intl.formatMessage(messages.change)}
                    </SettingsButton>
                  </div>
                </div>
                {limitOpen ? (
                  <div className="model-services__row">
                    <label htmlFor="personal-model-limit">{intl.formatMessage(messages.limitMonthlyMaximum)}</label>
                    <div>
                      <SettingsTextInput
                        id="personal-model-limit"
                        type="number"
                        min={0}
                        step={1}
                        value={limitDraft}
                        disabled={busy}
                        onChange={(e) => setLimitDraft(e.target.value)}
                      />
                      <div className="model-services__connection-actions">
                        <SettingsButton disabled={busy} onClick={() => setLimitOpen(false)}>
                          {intl.formatMessage(messages.cancel)}
                        </SettingsButton>
                        <SettingsButton
                          disabled={
                            busy ||
                            limitDraft.trim() === "" ||
                            !Number.isSafeInteger(Number(limitDraft)) ||
                            Number(limitDraft) < 0
                          }
                          onClick={() =>
                            void write(
                              {
                                action: "personalLimit",
                                monthlyTokens: Number(limitDraft),
                                revision: doc.personalLimit.revision,
                              },
                              () => setLimitOpen(false),
                            )
                          }
                        >
                          {intl.formatMessage(messages.limitSave)}
                        </SettingsButton>
                      </div>
                    </div>
                  </div>
                ) : null}
              </section>
            ) : null}
            {error && doc && !scopeOpen ? (
              <SettingsNotice tone="error">
                {error}
                <SettingsButton disabled={busy} onClick={() => void refresh()}>
                  {intl.formatMessage(messages.refresh)}
                </SettingsButton>
              </SettingsNotice>
            ) : null}
            <p className="model-services__status" role="status">
              {busy ? intl.formatMessage(messages.saving) : message}
            </p>
          </div>
        </div>
      </div>
    );
  };
}
