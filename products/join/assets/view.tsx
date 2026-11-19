import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useIntl } from "@opencraft/i18n/react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { ModalContent } from "@opencraft/design-system-web/modal-content";
import { AdaptiveSheetHandle } from "@opencraft/design-system-web/adaptive-sheet";
import { useWorkbenchPresentationRoot } from "@opencraft/design-system-web/presentation-root";
import {
  SettingsCollection,
  SettingsCollectionDocument,
  SettingsCollectionNavigation,
  SettingsCollectionSection,
  SettingsCollectionPanel,
  SettingsCollectionRow,
  SettingsCollectionFooter,
} from "@opencraft/extension-react/settings-collection";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import {
  SettingsPageHeader,
  SettingsSection,
  SettingsGroup,
  SettingsListItem,
  SettingsButton,
  SettingsNotice,
  SettingsActions,
  SettingsRow,
  SettingsTextInput,
  SettingsChoiceSelect,
  SettingsControlPair,
  SegmentedControl,
  SettingsPanel,
  type ExtensionSettingsViewProps,
} from "@opencraft/extension-react";
import {
  RefreshIcon,
  ChevronLeftIcon,
  AddIcon,
} from "@opencraft/design-system-web/action-icons";
import type { TencentOaController } from "../plugins/tencentoa/src/controller";
import {
  useEmployeeGitCredentials,
  EmployeeGitConnectionForm,
} from "../plugins/tencentoa/src/git-credentials-view";
import { PersonalEnvironmentVariables } from "../plugins/tencentoa/src/environment-variables-view";
import type { EmployeeGitHost } from "../plugins/tencentoa/src/git-credentials-contract";
import {
  SANDBOX_CONFIG_PATH,
  assetSource,
  type AssetSource,
  type E2BCredential,
  type SandboxConfiguration,
  type SandboxConfigurationsSnapshot,
  type SandboxConfigurationInput,
} from "./contract";
import { labels, type AssetMessage } from "./messages";
import { assetProviders, providersFor, type AssetProvider } from "./providers";
import {
  parseAssetCatalog,
  connectionLabel,
  catalogRevision,
  mergeAssetCatalog,
} from "./catalog";
import { ASSETS_CONNECTIONS_RESOURCE } from "./navigation";
import { AssetDetails } from "./details";
import {
  DatabaseIcon,
  CloudIcon,
  CodeIcon,
  ServerIcon,
} from "@opencraft/design-system-web/action-icons";
import "./view.scss";

type Tab = "environments" | "connections" | "libraries";
type ConnectionDraft = {
  source: AssetSource;
  kind: "connection";
  revision: number;
  id?: string;
  name: string;
  apiUrl: string;
  sandboxUrl: string;
  apiKey: string;
};
type EnvironmentDraft = {
  source: AssetSource;
  kind: "environment";
  revision: number;
  id?: string;
  name: string;
  credentialId: string;
  templateId: string;
};
type Editor =
  | ConnectionDraft
  | EnvironmentDraft
  | { kind: "git"; host: EmployeeGitHost }
  | { kind: "variables" };
type Deletion = {
  source: AssetSource;
  kind: "connection" | "environment";
  id: string;
  name: string;
  revision: number;
};
const tabFor = (editor: Editor): Tab =>
  editor.kind === "environment" ? "environments" : "connections";

export function createAssetsView(
  controller: TencentOaController,
  fetcher: typeof fetch,
  personalVariables = false,
) {
  return function AssetsView(props: ExtensionSettingsViewProps) {
    const state = useSyncExternalStore(
        controller.subscribe,
        controller.getSnapshot,
        controller.getSnapshot,
      ),
      intl = useIntl();
    const scope = state.identity ? `tencentoa:${state.identity.staffId}` : null;
    return scope ? (
      <AccountAssets
        key={scope}
        scope={scope}
        personalVariables={personalVariables}
        controller={controller}
        fetcher={fetcher}
        {...props}
      />
    ) : (
      <SettingsCollectionDocument className="join-assets">
        <SettingsPageHeader
          title={intl.formatMessage({
            id: "assets.title",
            defaultMessage: labels.title,
          })}
        />
        <SettingsNotice>
          {intl.formatMessage({
            id: "assets.identity",
            defaultMessage: labels.identity,
          })}
        </SettingsNotice>
        <SettingsButton onClick={() => void controller.refresh()}>
          {intl.formatMessage({
            id: "assets.refresh",
            defaultMessage: labels.refresh,
          })}
        </SettingsButton>
      </SettingsCollectionDocument>
    );
  };
}
function AccountAssets({
  scope,
  personalVariables,
  fetcher,
  controller,
  host,
  activation,
  regions,
}: ExtensionSettingsViewProps & {
  scope: string;
  personalVariables: boolean;
  fetcher: typeof fetch;
  controller: TencentOaController;
}) {
  const Header = regions?.Header;
  const presentationRoot = useWorkbenchPresentationRoot();
  const intl = useIntl(),
    f = (key: AssetMessage) =>
      intl.formatMessage({ id: "assets." + key, defaultMessage: labels[key] }),
    formId = useId();
  const [tab, setTab] = useState<Tab>(() =>
      personalVariables ||
      activation.resourceUri === ASSETS_CONNECTIONS_RESOURCE
        ? "connections"
        : "environments",
    ),
    [snapshot, setSnapshot] = useState<SandboxConfigurationsSnapshot>();
  // Resource navigation selects a section, just like the tabs: do not reset drafts.
  useEffect(() => {
    if (activation.resourceUri === ASSETS_CONNECTIONS_RESOURCE)
      setTab("connections");
  }, [activation.resourceUri]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [catalogReadError, setCatalogReadError] = useState(""),
    [notice, setNotice] = useState("");
  const [showEndpoints, setShowEndpoints] = useState(false);
  const invalidEndpoint = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const field = invalidEndpoint.current;
    if (!showEndpoints || !field) return;
    invalidEndpoint.current = null;
    if (field.isConnected && field.getClientRects().length) {
      field.focus();
      field.reportValidity();
    }
  }, [showEndpoints]);
  const addTrigger = useRef<HTMLButtonElement>(null);
  const [focusSearch, setFocusSearch] = useState<
    "environments" | "connections" | null
  >(null);
  useEffect(() => {
    if (!focusSearch) return;
    (
      searchInputs.current[focusSearch] ??
      addTrigger.current ??
      root.current
    )?.focus();
    setFocusSearch(null);
  }, [focusSearch]);
  const searchInputs = useRef<
    Partial<Record<"environments" | "connections", HTMLInputElement | null>>
  >({});
  const [rotation, setRotation] = useState(false);
  const [editor, setEditor] = useState<Editor | undefined>(() =>
      personalVariables ? { kind: "variables" } : undefined,
    ),
    [picker, setPicker] = useState(false),
    [returnEnvironment, setReturnEnvironment] = useState<EnvironmentDraft>();
  const [deletion, setDeletion] = useState<Deletion>(),
    [discard, setDiscard] = useState(false),
    [gitDirty, setGitDirty] = useState(false);
  const [envState, setEnvState] = useState({ dirty: false, writing: false });
  const envStateChanged = useCallback(
    (state: { dirty: boolean; writing: boolean }) => setEnvState(state),
    [],
  );
  const [queries, setQueries] = useState({ environments: "", connections: "" }),
    [providerFilter, setProviderFilter] = useState("all");
  const life = useRef<AbortController | null>(null),
    lock = useRef<AbortController | null>(null),
    root = useRef<HTMLDivElement>(null);
  const initial = useRef(""),
    pendingNavigation = useRef<() => void>(() => {}),
    trigger = useRef<HTMLElement | null>(null);
  const editorHeading = useRef<HTMLSpanElement>(null),
    mutationUnknown = useRef(false),
    mutationInFlight = useRef(false),
    returnInitial = useRef("");
  const expired = useCallback(() => {
    void controller.refresh();
  }, [controller]);
  const git = useEmployeeGitCredentials({
    scope,
    fetcher,
    onUnauthorized: expired,
  });
  const gitDraftChanged = useCallback(
    (dirty: boolean) => setGitDirty(dirty),
    [],
  );
  const isCurrentAccount = () => {
    const identity = controller.getSnapshot().identity;
    return identity && `tencentoa:${identity.staffId}` === scope;
  };
  function revokePlatform() {
    setSnapshot((previous) =>
      previous
        ? {
            ...previous,
            canManagePlatform: false,
            credentials: previous.credentials.filter(
              (c) => assetSource(c) !== "platform",
            ),
          }
        : previous,
    );
    setEditor((previous) =>
      previous &&
      previous.kind !== "git" &&
      previous.kind !== "variables" &&
      previous.source === "platform"
        ? undefined
        : previous,
    );
    setReturnEnvironment((previous) =>
      previous?.source === "platform" ? undefined : previous,
    );
    setDeletion((previous) =>
      previous?.source === "platform" ? undefined : previous,
    );
    setRotation(false);
    setDiscard(false);
    pendingNavigation.current = () => {};
  }
  async function request(
    input?: SandboxConfigurationInput,
  ): Promise<SandboxConfigurationsSnapshot | undefined> {
    if (
      lock.current ||
      !life.current ||
      life.current.signal.aborted ||
      !isCurrentAccount()
    )
      return;
    mutationInFlight.current = !!input;
    setBusy(true);
    if (!input) setCatalogReadError("");
    setError("");
    setNotice("");
    const abort = new AbortController(),
      parent = life.current;
    lock.current = abort;
    const retire = () => abort.abort();
    parent.signal.addEventListener("abort", retire, { once: true });
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetcher(SANDBOX_CONFIG_PATH, {
        method: input ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: abort.signal,
        headers: {
          "x-opencraft-account-scope": scope,
          ...(input ? { "content-type": "application/json" } : {}),
        },
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
      if (parent.signal.aborted || !isCurrentAccount()) return;
      const revoke = () => {
        setSnapshot(undefined);
        setEditor(undefined);
        setReturnEnvironment(undefined);
        setGitDirty(false);
        setEnvState({ dirty: false, writing: false });
        setDeletion(undefined);
        setDiscard(false);
        setRotation(false);
        initial.current = "";
        returnInitial.current = "";
        pendingNavigation.current = () => {};
        expired();
      };
      if (response.status === 401) {
        revoke();
        throw Error("failed");
      }
      let body;
      try {
        body = await response.json();
      } catch (cause) {
        if (response.status === 403) revoke();
        throw cause;
      }
      if (response.status === 403 && body?.error === "administrator_required")
        revokePlatform();
      if (
        response.status === 403 &&
        !["custom_endpoint_admin", "administrator_required"].includes(
          body?.error,
        )
      ) {
        revoke();
        throw Error("failed");
      }
      if (parent.signal.aborted || !isCurrentAccount()) return;
      if (abort.signal.aborted) throw Error("failed");
      if (!response.ok)
        throw Error(typeof body?.error === "string" ? body.error : "failed");
      const next = parseAssetCatalog(body, scope);
      setCatalogReadError("");
      if (!next.canManagePlatform) revokePlatform();
      setSnapshot((previous) => mergeAssetCatalog(previous, next));
      if (input) setNotice(f("saved"));
      return next;
    } catch (cause) {
      if (!parent.signal.aborted && isCurrentAccount()) {
        const key = cause instanceof Error ? cause.message : "failed";
        if (input && (!Object.hasOwn(labels, key) || key === "failed"))
          mutationUnknown.current = true;
        if (!input) setCatalogReadError(f("catalogReadFailed"));
        else
          setError(
            f(
              Object.hasOwn(labels, key)
                ? (key as AssetMessage)
                : key === "invalid_template"
                  ? "invalid"
                  : "failed",
            ),
          );
      }
    } finally {
      clearTimeout(timer);
      parent.signal.removeEventListener("abort", retire);
      if (lock.current === abort) {
        lock.current = null;
        mutationInFlight.current = false;
        if (!parent.signal.aborted) setBusy(false);
      }
    }
  }
  useEffect(() => {
    const owner = new AbortController();
    life.current = owner;
    void request();
    return () => {
      owner.abort();
      if (life.current === owner) {
        life.current = null;
        lock.current?.abort();
        lock.current = null;
      }
    };
  }, [scope]);
  const dirty =
    !!editor &&
    (editor.kind === "variables"
      ? envState.dirty
      : editor.kind === "git"
        ? gitDirty
        : JSON.stringify(editor) !== initial.current ||
          mutationUnknown.current);
  const cancelLeave = useRef<(() => void) | null>(null);
  const leaveBypass = useRef(false);
  const leaveState = useRef({ dirty: false, writing: false, current: true });
  leaveState.current = {
    dirty: dirty || !!returnEnvironment,
    writing:
      mutationInFlight.current ||
      (editor?.kind === "git" && git.busy) ||
      (editor?.kind === "variables" && envState.writing),
    current: !!isCurrentAccount(),
  };
  useEffect(
    () =>
      host.registerNavigationGuard?.(
        () =>
          !leaveBypass.current &&
          leaveState.current.current &&
          (leaveState.current.dirty || leaveState.current.writing),
        (attempt) => {
          if (leaveState.current.writing) {
            attempt.cancel();
            return;
          }
          cancelLeave.current?.();
          cancelLeave.current = attempt.cancel;
          rememberTrigger();
          pendingNavigation.current = attempt.proceed;
          setDiscard(true);
        },
      ),
    [host.registerNavigationGuard],
  );
  useEffect(() => {
    if (!dirty && !returnEnvironment && !leaveState.current.writing) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, returnEnvironment, busy, git.busy, envState.writing]);
  useEffect(() => {
    (
      editorHeading.current ??
      root.current?.querySelector<HTMLButtonElement>(
        ".join-assets__editor button",
      )
    )?.focus({
      preventScroll: true,
    });
  }, [editor?.kind, editor && "id" in editor ? editor.id : undefined, picker]);
  function rememberTrigger() {
    trigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }
  function clearFeedback() {
    setError("");
    setNotice("");
  }
  function setDraft(next: Editor | undefined) {
    invalidEndpoint.current = null;
    setShowEndpoints(false);
    setRotation(false);
    setEditor(next);
    initial.current = JSON.stringify(next);
    setGitDirty(false);
    setEnvState({ dirty: false, writing: false });
    setPicker(false);
    mutationUnknown.current = false;
    clearFeedback();
  }
  function guard(action: () => void) {
    if (
      (busy && mutationInFlight.current) ||
      (editor?.kind === "git" && git.busy) ||
      (editor?.kind === "variables" && envState.writing)
    )
      return;
    if (dirty) {
      rememberTrigger();
      pendingNavigation.current = action;
      setDiscard(true);
    } else action();
  }
  function beginConnection(
    c?: E2BCredential,
    source: AssetSource = c ? assetSource(c) : "personal",
  ) {
    if (!snapshot || busy || !isCurrentAccount()) return;
    setDraft({
      kind: "connection",
      source,
      revision: catalogRevision(snapshot!, source),
      ...(c ? { id: c.id } : {}),
      name: c?.name ?? "",
      apiUrl: c?.apiUrl ?? "https://api.e2b.dev",
      sandboxUrl: c?.sandboxUrl ?? "https://e2b.dev",
      apiKey: "",
    });
    setTab("connections");
  }
  function beginEnvironment(e?: SandboxConfiguration) {
    if (!snapshot || busy || !isCurrentAccount()) return;
    setReturnEnvironment(undefined);
    setDraft({
      kind: "environment",
      source: e ? assetSource(e) : "personal",
      revision: catalogRevision(snapshot!, e ? assetSource(e) : "personal"),
      ...(e ? { id: e.id } : {}),
      name: e?.name ?? "",
      credentialId: e?.credentialId ?? "",
      templateId: e?.templateId ?? "",
    });
    setTab("environments");
  }
  function openProvider(provider: AssetProvider) {
    guard(() => {
      setReturnEnvironment(undefined);
      if (provider.editor === "e2b") beginConnection();
      else if (provider.host) {
        if (
          !git.snapshot ||
          git.busy ||
          git.unauthorized ||
          !isCurrentAccount()
        )
          return;
        setDraft({ kind: "git", host: provider.host });
        setTab("connections");
      }
    });
  }
  function closeEditor() {
    guard(() => {
      if (returnEnvironment) {
        const draft = returnEnvironment;
        setReturnEnvironment(undefined);
        setDraft(draft);
        initial.current = returnInitial.current;
        setTab("environments");
      } else {
        setDraft(undefined);
        root.current?.focus({ preventScroll: true });
      }
    });
  }
  async function save(confirmed = false) {
    if (!editor || editor.kind === "git" || editor.kind === "variables") return;
    if (
      (editor.source === "platform" ||
        (editor.kind === "connection" && editor.id && editor.apiKey)) &&
      !confirmed
    ) {
      rememberTrigger();
      setRotation(true);
      return;
    }
    const savedEditor = editor,
      previousIds = new Set(
        snapshot?.credentials
          .filter((c) => assetSource(c) === editor.source)
          .map((c) => c.id),
      );
    const input: SandboxConfigurationInput =
      editor.kind === "connection"
        ? {
            action: "save-credential",
            revision: editor.revision,
            source: editor.source,
            ...(editor.id ? { id: editor.id } : {}),
            name: editor.name,
            apiUrl: editor.apiUrl,
            sandboxUrl: editor.sandboxUrl,
            ...(editor.apiKey ? { apiKey: editor.apiKey } : {}),
          }
        : {
            action: "save-environment",
            revision: editor.revision,
            source: editor.source,
            ...(editor.id ? { id: editor.id } : {}),
            name: editor.name,
            credentialId: editor.credentialId,
            templateId: editor.templateId,
          };
    const next = await request(input);
    if (!next) return;
    setRotation(false);
    if (returnEnvironment && savedEditor.kind === "connection") {
      const added = next.credentials.find(
        (c) =>
          assetSource(c) === savedEditor.source &&
          (savedEditor.id ? c.id === savedEditor.id : !previousIds.has(c.id)),
      );
      const draft = {
        ...returnEnvironment,
        credentialId: added?.id ?? returnEnvironment.credentialId,
        revision: catalogRevision(next, returnEnvironment.source),
      };
      setReturnEnvironment(undefined);
      setDraft(draft);
      initial.current = "";
      setTab("environments");
      setNotice(f("updatedEnvironment"));
    } else {
      setDraft(undefined);
      setQueries((q) => ({
        ...q,
        [savedEditor.kind === "connection" ? "connections" : "environments"]:
          "",
      }));
      if (savedEditor.kind === "connection") setProviderFilter("all");
      setNotice(f("saved"));
      root.current?.focus({ preventScroll: true });
    }
  }
  const query = (tab === "libraries" ? "" : queries[tab])
    .trim()
    .toLocaleLowerCase();
  const matches = (...fields: string[]) =>
    fields.some((value) => value.toLocaleLowerCase().includes(query));
  const environmentRows =
    snapshot?.environments.filter((e) =>
      matches(
        e.name,
        e.templateId,
        snapshot.credentials.find(
          (c) => c.id === e.credentialId && assetSource(c) === assetSource(e),
        )?.name ?? "",
      ),
    ) ?? [];
  const connections =
    snapshot?.credentials.filter(
      (c) =>
        (providerFilter === "all" || providerFilter === "e2b") &&
        matches(c.name, "E2B", c.apiUrl),
    ) ?? [];
  const gitProviders = assetProviders.filter(
    (p) =>
      p.editor === "git" &&
      !!(
        p.host &&
        (git.snapshot?.hosts[p.host]?.configured ||
          git.snapshot?.hosts[p.host]?.sshAuth ||
          (p.id === "gongfeng" && git.snapshot?.gongfengMcp.configured))
      ) &&
      (providerFilter === "all" || providerFilter === p.id) &&
      matches(
        p.id,
        p.name,
        p.id === "gongfeng" ? f("gongfeng") : "",
        p.host ?? "",
        p.host ? (git.snapshot?.hosts[p.host]?.identity?.username ?? "") : "",
      ),
  );
  const editingHere = !!editor && tabFor(editor) === tab;
  const environmentProvider = providersFor("environments").find(
    (provider) => provider.editor === "e2b",
  );
  const canMutate = !!snapshot && !busy;
  const navigationBusy =
    (busy && mutationInFlight.current) ||
    (editor?.kind === "git" && git.busy) ||
    (editor?.kind === "variables" && envState.writing);
  const canOpenPicker = !navigationBusy && isCurrentAccount();
  const canManageGit = !!git.snapshot && !git.busy && !git.unauthorized;
  function clearFilters(which: "environments" | "connections") {
    setQueries((current) => ({ ...current, [which]: "" }));
    if (which === "connections") setProviderFilter("all");
    // The no-results action disappears; retain focus on a stable control.
    setFocusSearch(which);
  }
  const titleFor = (p: AssetProvider) =>
    p.id === "gongfeng" ? f("gongfeng") : p.name;
  const editorUsage =
    editor?.kind === "connection" && editor.id
      ? (snapshot?.environments.filter(
          (e) =>
            e.credentialId === editor.id && assetSource(e) === editor.source,
        ) ?? [])
      : [];
  const editorConnections =
    editor && editor.kind !== "git" && editor.kind !== "variables"
      ? (snapshot?.credentials.filter(
          (c) => assetSource(c) === editor.source,
        ) ?? [])
      : [];
  const platformEditor =
    editor &&
    editor.kind !== "git" &&
    editor.kind !== "variables" &&
    editor.source === "platform";
  const refresh = () => {
    void request();
    void git.load();
  };
  const closeConfirmation = () => {
    trigger.current?.isConnected
      ? trigger.current.focus()
      : root.current?.focus();
  };
  function searchControls(which: "environments" | "connections") {
    if (which === "environments")
      return (
        <SettingsTextInput
          ref={(node) => {
            searchInputs.current.environments = node;
          }}
          aria-label={f("search")}
          placeholder={f("search")}
          value={queries.environments}
          onChange={(event) =>
            setQueries({ ...queries, environments: event.target.value })
          }
        />
      );
    return (
      <SettingsControlPair
        primary={
          <SettingsTextInput
            ref={(node) => {
              searchInputs.current.connections = node;
            }}
            aria-label={f("search")}
            placeholder={f("search")}
            value={queries[which]}
            onChange={(event) =>
              setQueries({ ...queries, [which]: event.target.value })
            }
          />
        }
        companion={
          which === "connections" ? (
            <SettingsChoiceSelect
              label={f("filter")}
              value={providerFilter}
              options={[
                { value: "all", label: f("allProviders") },
                ...assetProviders.map((p) => ({
                  value: p.id,
                  label: titleFor(p),
                })),
              ]}
              onValueChange={setProviderFilter}
            />
          ) : (
            <span>E2B</span>
          )
        }
      />
    );
  }
  const openPicker = () =>
    guard(() => {
      setEditor(undefined);
      setReturnEnvironment(undefined);
      setPicker(true);
      clearFeedback();
    });
  const actions = (
    <>
      <IconButton
        aria-label={f("refresh")}
        title={f("refresh")}
        disabled={busy || git.busy}
        onClick={refresh}
      >
        <RefreshIcon />
      </IconButton>
      {!editingHere && tab !== "libraries" ? (
        <Button
          ref={addTrigger}
          variant="primary"
          size="sm"
          contentLayout="row"
          disabled={
            tab === "environments"
              ? !canMutate || navigationBusy
              : !canOpenPicker
          }
          onClick={
            tab === "environments"
              ? () => environmentProvider && guard(() => beginEnvironment())
              : openPicker
          }
        >
          <AddIcon />
          {f(tab === "environments" ? "addEnvironment" : "addConnection")}
        </Button>
      ) : null}
    </>
  );
  const renderEnvironment = (e: SandboxConfiguration) => {
    const manageable =
      assetSource(e) === "personal" || snapshot?.canManagePlatform;
    const description = `E2B · ${f("template")} ${e.templateId}`;
    return manageable ? (
      <SettingsCollectionRow
        key={`${assetSource(e)}:${e.id}`}
        label={e.name}
        icon={<CloudIcon />}
        description={description}
        aria-label={`${f("manage")} ${e.name}`}
        disabled={!canMutate}
        onClick={() => guard(() => beginEnvironment(e))}
      />
    ) : (
      <SettingsListItem
        key={`${assetSource(e)}:${e.id}`}
        label={e.name}
        icon={<CloudIcon />}
        description={description}
      />
    );
  };
  const totalConnections =
    (snapshot?.credentials.length ?? 0) +
    assetProviders.filter(
      (p) =>
        p.host &&
        (git.snapshot?.hosts[p.host]?.configured ||
          git.snapshot?.hosts[p.host]?.sshAuth ||
          (p.id === "gongfeng" && git.snapshot?.gongfengMcp.configured)),
    ).length;
  return (
    <SettingsCollectionDocument
      className="join-assets"
      ref={root}
      tabIndex={-1}
    >
      {Header ? <Header>{null}</Header> : null}
      <SettingsPageHeader title={f("title")} description={f("catalogAbout")} />
      <SettingsCollectionNavigation actions={actions}>
        <SegmentedControl
          appearance="underline"
          width="content"
          label={f("title")}
          value={tab}
          onValueChange={(value) => setTab(value as Tab)}
          options={(["libraries", "environments", "connections"] as const).map(
            (value) => ({
              value,
              label: f(value),
            }),
          )}
        />
      </SettingsCollectionNavigation>
      {error || notice ? (
        <div className="join-assets__feedback" aria-live="polite">
          {error ? (
            <SettingsNotice tone="error">{error}</SettingsNotice>
          ) : (
            <span role="status">{notice}</span>
          )}
        </div>
      ) : null}
      {editingHere && catalogReadError ? (
        <SettingsNotice tone="error">{catalogReadError}</SettingsNotice>
      ) : null}
      {editor && !editingHere ? (
        <SettingsNotice>
          <span>{f("draftRetained")} </span>
          <SettingsButton
            variant="quiet"
            onClick={() => setTab(tabFor(editor))}
          >
            {f("continueEditing")}
          </SettingsButton>
        </SettingsNotice>
      ) : null}
      <SettingsCollection
        hidden={tab !== "libraries"}
        className="join-assets__sections"
      >
        <SettingsCollectionSection title={f("libraries")}>
          {snapshot?.libraries?.length ? (
            <SettingsGroup>
              {snapshot.libraries.map((library) => (
                <SettingsCollectionRow
                  key={library.id}
                  label={library.name}
                  icon={<DatabaseIcon />}
                  description={`${library.status === "configured" ? f("libraryConfigured") : f("libraryUnavailable")} · NFS · ${library.mountPath}`}
                  onClick={() => guard(() => setTab("environments"))}
                />
              ))}
            </SettingsGroup>
          ) : (
            <SettingsNotice>{f("libraryEmpty")}</SettingsNotice>
          )}
          <SettingsCollectionFooter>
            {f("libraryBoundary")}
          </SettingsCollectionFooter>
          {snapshot?.libraries?.map((library) => (
            <AssetDetails
              key={library.id}
              label={`${library.name} · ${f("libraryDetails")}`}
            >
              <p>{f("libraryManaged")}</p>
              <p>
                {f("libraryCompatible")}:{" "}
                {library.environmentIds
                  .map(
                    (id) =>
                      snapshot.environments.find(
                        (e) => e.id === id && assetSource(e) === "platform",
                      )?.name,
                  )
                  .filter(Boolean)
                  .join(" · ") || f("libraryUnavailable")}
              </p>
              <p>
                {f("libraryVerified")}: {library.verifiedAt}
              </p>
              <p>{f("libraryScope")}</p>
            </AssetDetails>
          ))}
        </SettingsCollectionSection>
      </SettingsCollection>
      <SettingsCollection
        appearance="list"
        hidden={tab !== "environments" || editingHere}
        className="join-assets__sections"
      >
        {(snapshot?.environments.length ?? 0) > 6 || queries.environments
          ? searchControls("environments")
          : null}
        <SettingsCollectionSection title={f("platform")}>
          <SettingsGroup>
            <SettingsListItem
              icon={<ServerIcon />}
              label={f("local")}
              description={f("localAbout")}
            />
            {environmentRows
              .filter((e) => assetSource(e) === "platform")
              .map(renderEnvironment)}
          </SettingsGroup>
        </SettingsCollectionSection>
        <SettingsCollectionSection title={f("personalEnvironments")}>
          <div className="join-assets__collection">
            <SettingsGroup
              appearance={
                environmentRows.some((e) => assetSource(e) === "personal")
                  ? "card"
                  : "plain"
              }
            >
              {!snapshot ? (
                busy ? (
                  <SettingsNotice>{f("loading")}</SettingsNotice>
                ) : null
              ) : environmentRows.some((e) => assetSource(e) === "personal") ? (
                environmentRows
                  .filter((e) => assetSource(e) === "personal")
                  .map(renderEnvironment)
              ) : (
                <div className="join-assets__empty">
                  <p>{query ? f("noResults") : f("emptyEnvironment")}</p>
                  <SettingsButton
                    variant={query ? "quiet" : "primary"}
                    disabled={!query && (!canMutate || !environmentProvider)}
                    onClick={
                      query
                        ? () => clearFilters("environments")
                        : () =>
                            environmentProvider &&
                            guard(() => beginEnvironment())
                    }
                  >
                    {f(query ? "clearFilters" : "createEnvironment")}
                  </SettingsButton>
                </div>
              )}
            </SettingsGroup>
            {catalogReadError ? (
              <SettingsNotice tone="error">{catalogReadError}</SettingsNotice>
            ) : null}
          </div>
        </SettingsCollectionSection>
        <div>
          <SettingsCollectionFooter>
            {f("environmentSaveHint")}
          </SettingsCollectionFooter>
          <SettingsButton
            variant="quiet"
            onClick={() => guard(() => host.openView("opencraft.im.agents"))}
          >
            {f("viewAssistants")}
          </SettingsButton>
        </div>
      </SettingsCollection>
      <SettingsCollection
        appearance="list"
        hidden={tab !== "connections" || editingHere}
        className="join-assets__sections"
      >
        <SettingsCollectionSection title={f("connections")}>
          <div className="join-assets__collection">
            {totalConnections || queries.connections || providerFilter !== "all"
              ? searchControls("connections")
              : null}
            <SettingsGroup
              appearance={
                gitProviders.length || connections.length ? "card" : "plain"
              }
            >
              {gitProviders.map((provider) => (
                <SettingsCollectionRow
                  key={provider.id}
                  icon={<CodeIcon />}
                  label={titleFor(provider)}
                  description={
                    provider.id === "gongfeng"
                      ? `${git.snapshot?.hosts[provider.host!]?.identity?.username ?? f("gongfeng")} · Git：${git.snapshot?.hosts[provider.host!]?.sshAuth ? "密钥已生成" : "未配置密钥"} · MCP：${git.snapshot?.gongfengMcp.configured ? "令牌已保存" : "未配置令牌"}`
                      : git.snapshot?.hosts[provider.host!]?.identity?.username ?? f("configured")
                  }
                  aria-label={`${f("manage")} ${titleFor(provider)}`}
                  disabled={!canManageGit || navigationBusy}
                  onClick={() => openProvider(provider)}
                />
              ))}
              {connections.map((c) => (
                <SettingsCollectionRow
                  key={`${assetSource(c)}:${c.id}`}
                  label={connectionLabel(c, snapshot?.credentials ?? [])}
                  icon={<CloudIcon />}
                  description={`E2B · ${f(assetSource(c))}`}
                  aria-label={`${f("manage")} ${c.name}`}
                  disabled={!canMutate}
                  onClick={() =>
                    guard(() => {
                      setReturnEnvironment(undefined);
                      beginConnection(c);
                    })
                  }
                />
              ))}
              {!snapshot ? (
                busy ? (
                  <SettingsNotice>{f("loading")}</SettingsNotice>
                ) : null
              ) : !git.snapshot && git.busy ? (
                <SettingsNotice>{f("loading")}</SettingsNotice>
              ) : !connections.length &&
                !gitProviders.length &&
                !git.operationErrors.read ? (
                <div className="join-assets__empty">
                  <p>
                    {query || providerFilter !== "all"
                      ? f("noResults")
                      : f("emptyConnections")}
                  </p>
                  {!query && providerFilter === "all" ? (
                    <p className="join-assets__subtle">{f("providerAbout")}</p>
                  ) : null}
                  <SettingsButton
                    variant={
                      query || providerFilter !== "all" ? "quiet" : "primary"
                    }
                    disabled={
                      !query && providerFilter === "all" && !canOpenPicker
                    }
                    onClick={
                      query || providerFilter !== "all"
                        ? () => clearFilters("connections")
                        : openPicker
                    }
                  >
                    {f(
                      query || providerFilter !== "all"
                        ? "clearFilters"
                        : "addAccount",
                    )}
                  </SettingsButton>
                </div>
              ) : null}
            </SettingsGroup>
            {catalogReadError ? (
              <SettingsNotice tone="error">{catalogReadError}</SettingsNotice>
            ) : null}
            {git.operationErrors.read ? (
              <SettingsNotice tone="error">
                {git.operationErrors.read}
              </SettingsNotice>
            ) : null}
          </div>
          <SettingsCollectionFooter>
            {f("codeAccountShort")}
          </SettingsCollectionFooter>
        </SettingsCollectionSection>
        <SettingsCollectionSection title={f("envVariables")}>
          <SettingsGroup>
            <SettingsCollectionRow
              icon={<CodeIcon />}
              label={intl.formatMessage({
                id: "ioa.env.title",
                defaultMessage: "Personal credentials ENV",
              })}
              description={f("envVariablesAbout")}
              aria-label={f("openVariables")}
              disabled={navigationBusy}
              onClick={() =>
                guard(() => {
                  setReturnEnvironment(undefined);
                  setDraft({ kind: "variables" });
                })
              }
            />
          </SettingsGroup>
        </SettingsCollectionSection>
      </SettingsCollection>
      <Dialog.Root open={picker} onOpenChange={setPicker}>
        <ModalContent
          data-presentation="adaptive-sheet"
          data-size="default"
          data-viewport-owner={presentationRoot ? undefined : "document"}
          overlayProps={{
            "data-appearance": "utility",
            "data-presentation": "adaptive-sheet",
          }}
          onCloseAutoFocus={(event) => {
            // Provider selection moves focus into the form; Cancel/Escape restores the opener.
            if (editor) {
              event.preventDefault();
              // The Git form owns its heading; use its existing Back action rather
              // than focusing an input and opening the mobile keyboard.
              const destination =
                editorHeading.current ??
                root.current?.querySelector<HTMLButtonElement>(
                  ".join-assets__editor button",
                );
              destination?.focus({ preventScroll: true });
            }
          }}
        >
          <AdaptiveSheetHandle onDismiss={() => setPicker(false)} />
          <SettingsCollectionPanel
            title={
              <Dialog.Title asChild>
                <span>{f("chooseProvider")}</span>
              </Dialog.Title>
            }
            actions={
              <Dialog.Close asChild>
                <SettingsButton variant="quiet">{f("cancel")}</SettingsButton>
              </Dialog.Close>
            }
          >
            <Dialog.Description className="join-assets__subtle">
              {f("providerAbout")}
            </Dialog.Description>
            <SettingsCollection className="join-assets__provider-groups">
              {(["git", "e2b"] as const).map((kind) => (
                <SettingsCollectionSection
                  key={kind}
                  title={f(
                    kind === "git" ? "codeAccessRole" : "provisioningRole",
                  )}
                >
                  <SettingsGroup>
                    {assetProviders
                      .filter((provider) => provider.editor === kind)
                      .map((provider) => (
                        <SettingsCollectionRow
                          key={provider.id}
                          label={titleFor(provider)}
                          description={f(provider.about)}
                          icon={
                            provider.id === "e2b" ? <CloudIcon /> : <CodeIcon />
                          }
                          aria-label={`${f("choose")} ${titleFor(provider)}`}
                          disabled={
                            navigationBusy ||
                            (provider.editor === "git"
                              ? !canManageGit
                              : !canMutate)
                          }
                          onClick={() => openProvider(provider)}
                        />
                      ))}
                  </SettingsGroup>
                </SettingsCollectionSection>
              ))}
            </SettingsCollection>
          </SettingsCollectionPanel>
        </ModalContent>
      </Dialog.Root>

      {editor ? (
        <SettingsCollection
          hidden={!editingHere}
          className="join-assets__sections join-assets__editor"
        >
          <SettingsActions align="start">
            <SettingsButton
              variant="quiet"
              disabled={navigationBusy}
              onClick={closeEditor}
            >
              <ChevronLeftIcon />
              {returnEnvironment ? f("editEnvironment") : f("back")}
            </SettingsButton>
          </SettingsActions>
          {editor.kind === "variables" ? (
            <PersonalEnvironmentVariables
              controller={controller}
              fetcher={fetcher}
              scope={scope}
              onStateChange={envStateChanged}
            />
          ) : editor.kind === "git" ? (
            <>
              <p className="join-assets__subtle">{f("codeAccountHint")}</p>
              <EmployeeGitConnectionForm
                controller={git}
                host={editor.host}
                onDraftChange={gitDraftChanged}
              />
            </>
          ) : (
            <SettingsSection
              title={
                <span tabIndex={-1} ref={editorHeading}>
                  {f(
                    editor.kind === "connection"
                      ? editor.id
                        ? "editConnection"
                        : "newConnection"
                      : editor.id
                        ? "editEnvironment"
                        : "newEnvironment",
                  )}
                </span>
              }
            >
              <form
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  // Use native constraints once, then reveal the first invalid field.
                  // Opening details during native interactive validation lets later
                  // invalid fields steal focus from the first one.
                  if (!form.checkValidity()) {
                    const field =
                      form.querySelector<HTMLInputElement>("input:invalid");
                    if (
                      !showEndpoints &&
                      editor.kind === "connection" &&
                      field &&
                      [formId + "-api", formId + "-domain"].includes(field.id)
                    ) {
                      invalidEndpoint.current = field;
                      setShowEndpoints(true);
                    } else form.reportValidity();
                    return;
                  }
                  void save();
                }}
                aria-busy={busy}
              >
                <SettingsCollectionSection title={f("basicInfo")}>
                  <SettingsGroup>
                    {snapshot?.canManagePlatform &&
                    !editor.id &&
                    !returnEnvironment ? (
                      <SettingsRow layout="stacked" label={f("source")}>
                        <SettingsChoiceSelect
                          label={f("source")}
                          value={editor.source}
                          disabled={busy || mutationUnknown.current}
                          options={[
                            { value: "personal", label: f("personal") },
                            { value: "platform", label: f("platform") },
                          ]}
                          onValueChange={(value) => {
                            if (value !== "personal" && value !== "platform")
                              return;
                            if (mutationUnknown.current || busy) return;
                            setEditor({
                              ...editor,
                              source: value,
                              revision: catalogRevision(snapshot, value),
                              ...(editor.kind === "environment"
                                ? { credentialId: "" }
                                : { apiKey: "" }),
                            });
                            setRotation(false);
                          }}
                        />
                      </SettingsRow>
                    ) : (
                      <SettingsRow label={f("source")} controlWidth="compact">
                        {f(editor.source)}
                      </SettingsRow>
                    )}
                    <SettingsRow
                      layout="stacked"
                      label={f("name")}
                      htmlFor={formId + "-name"}
                    >
                      <SettingsTextInput
                        id={formId + "-name"}
                        required
                        maxLength={120}
                        value={editor.name}
                        disabled={busy}
                        onChange={(event) =>
                          setEditor({ ...editor, name: event.target.value })
                        }
                      />
                    </SettingsRow>
                  </SettingsGroup>
                </SettingsCollectionSection>
                <SettingsCollectionSection
                  title={f(
                    editor.kind === "environment"
                      ? "environmentSetup"
                      : "accessCredentials",
                  )}
                >
                  <SettingsGroup>
                    {editor.kind === "environment" ? (
                      <>
                        <SettingsRow
                          layout="stacked"
                          label={f("connection")}
                          description={f("creationConnectionHint")}
                          htmlFor={formId + "-connection"}
                        >
                          <div className="join-assets__field">
                            <SettingsChoiceSelect
                              id={formId + "-connection"}
                              label={f("chooseConnection")}
                              placeholder={f("chooseConnection")}
                              value={editor.credentialId}
                              options={
                                editorConnections.map((c) => ({
                                  value: c.id,
                                  label: connectionLabel(c, editorConnections),
                                })) ?? []
                              }
                              disabled={busy || !editorConnections.length}
                              onValueChange={(credentialId) =>
                                setEditor({ ...editor, credentialId })
                              }
                            />
                            <SettingsButton
                              variant="quiet"
                              disabled={busy}
                              onClick={() => {
                                returnInitial.current = initial.current;
                                setReturnEnvironment(editor);
                                beginConnection(undefined, editor.source);
                              }}
                            >
                              {f("createConnection")}
                            </SettingsButton>
                          </div>
                        </SettingsRow>
                        {!editorConnections.length ? (
                          <SettingsNotice>
                            {f("connectionNeeded")}
                          </SettingsNotice>
                        ) : editor.credentialId &&
                          !editorConnections.some(
                            (c) => c.id === editor.credentialId,
                          ) ? (
                          <SettingsNotice tone="error">
                            {f("credential_missing")}
                          </SettingsNotice>
                        ) : null}
                        <SettingsRow
                          layout="stacked"
                          label={f("template")}
                          htmlFor={formId + "-template"}
                        >
                          <SettingsTextInput
                            id={formId + "-template"}
                            required
                            maxLength={128}
                            pattern="[a-zA-Z0-9_\-]+"
                            value={editor.templateId}
                            disabled={busy}
                            onChange={(event) =>
                              setEditor({
                                ...editor,
                                templateId: event.target.value,
                              })
                            }
                          />
                        </SettingsRow>
                      </>
                    ) : (
                      <>
                        <SettingsRow
                          layout="stacked"
                          label={f("apiKey")}
                          description={f("secretsHint")}
                          htmlFor={formId + "-key"}
                        >
                          <SettingsTextInput
                            id={formId + "-key"}
                            type="password"
                            autoComplete="new-password"
                            required={!editor.id}
                            maxLength={4096}
                            disabled={busy}
                            value={editor.apiKey}
                            placeholder={editor.id ? f("savedKey") : undefined}
                            onChange={(event) =>
                              setEditor({
                                ...editor,
                                apiKey: event.target.value,
                              })
                            }
                          />
                        </SettingsRow>
                      </>
                    )}
                  </SettingsGroup>
                  {editor.kind === "connection" ? (
                    <SettingsCollectionFooter>
                      {f("connectionSaveHint")}
                    </SettingsCollectionFooter>
                  ) : null}
                </SettingsCollectionSection>
                {editor.kind === "connection" ? (
                  <AssetDetails
                    label={f("endpointSettings")}
                    open={showEndpoints}
                    onOpenChange={setShowEndpoints}
                  >
                    <p className="join-assets__subtle">
                      {f(
                        snapshot?.allowCustomEndpoints || editor.id
                          ? "customHint"
                          : "officialEndpoints",
                      )}
                    </p>
                    <SettingsGroup>
                      <SettingsRow
                        label={f("apiUrl")}
                        htmlFor={formId + "-api"}
                      >
                        <SettingsTextInput
                          id={formId + "-api"}
                          type="url"
                          required
                          disabled={
                            busy ||
                            !!editor.id ||
                            !snapshot?.allowCustomEndpoints
                          }
                          value={editor.apiUrl}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              apiUrl: event.target.value,
                            })
                          }
                        />
                      </SettingsRow>
                      <SettingsRow
                        label={f("sandboxUrl")}
                        htmlFor={formId + "-domain"}
                      >
                        <SettingsTextInput
                          id={formId + "-domain"}
                          type="url"
                          required
                          disabled={
                            busy ||
                            !!editor.id ||
                            !snapshot?.allowCustomEndpoints
                          }
                          value={editor.sandboxUrl}
                          onChange={(event) =>
                            setEditor({
                              ...editor,
                              sandboxUrl: event.target.value,
                            })
                          }
                        />
                      </SettingsRow>
                    </SettingsGroup>
                  </AssetDetails>
                ) : null}
                {editor.kind === "environment" ? (
                  <>
                    <p className="join-assets__subtle">
                      {f("environmentSaveHint")}
                    </p>
                    <AssetDetails label={f("usageNotes")}>
                      <p className="join-assets__subtle">{f("runtimeHint")}</p>
                    </AssetDetails>
                  </>
                ) : null}
                <SettingsActions align="start" wrap>
                  <SettingsButton
                    type="submit"
                    variant="primary"
                    disabled={
                      busy ||
                      !editor.name.trim() ||
                      (editor.kind === "connection"
                        ? !editor.id && !editor.apiKey
                        : !editor.templateId.trim() ||
                          !editorConnections.some(
                            (c) => c.id === editor.credentialId,
                          ))
                    }
                  >
                    {busy
                      ? f(mutationInFlight.current ? "saving" : "loading")
                      : returnEnvironment && editor.kind === "connection"
                        ? f("returnEnvironment")
                        : f("save")}
                  </SettingsButton>
                  <SettingsButton
                    variant="quiet"
                    disabled={busy}
                    onClick={closeEditor}
                  >
                    {f("cancel")}
                  </SettingsButton>
                </SettingsActions>
              </form>
              {editor.kind === "connection" && editor.id ? (
                <SettingsSection
                  title={f("connectionUsage")}
                  description={editorUsage.length ? f("inUse") : f("notUsed")}
                >
                  {editorUsage.length ? (
                    <SettingsGroup>
                      {editorUsage.map((e) => (
                        <SettingsListItem
                          key={`${assetSource(e)}:${e.id}`}
                          label={e.name}
                          description="E2B"
                          actions={
                            <SettingsButton
                              variant="quiet"
                              disabled={busy}
                              onClick={() => guard(() => beginEnvironment(e))}
                            >
                              {f("manage")}
                            </SettingsButton>
                          }
                        />
                      ))}
                    </SettingsGroup>
                  ) : null}
                </SettingsSection>
              ) : null}
              {editor.id ? (
                <SettingsActions align="start">
                  <SettingsButton
                    variant="danger"
                    disabled={!canMutate || editorUsage.length > 0}
                    onClick={() => {
                      rememberTrigger();
                      setDeletion({
                        kind: editor.kind,
                        source: editor.source,
                        id: editor.id!,
                        name: editor.name,
                        revision: editor.revision,
                      });
                    }}
                  >
                    {f(
                      editor.kind === "connection"
                        ? "removeConnection"
                        : "removeEnvironment",
                    )}
                  </SettingsButton>
                </SettingsActions>
              ) : null}
            </SettingsSection>
          )}
        </SettingsCollection>
      ) : null}

      <AlertDialog.Root
        open={!!deletion}
        onOpenChange={(open) => {
          if (!open && !busy) setDeletion(undefined);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay
            className="modal-surface__scrim"
            data-layer="confirmation"
            data-appearance="utility"
          />
          <AlertDialog.Content
            className="modal-surface"
            data-layer="confirmation"
            data-appearance="utility"
            data-size="compact"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              closeConfirmation();
            }}
          >
            <SettingsPanel
              title={
                <AlertDialog.Title asChild>
                  <span>{f("deleteTitle")}</span>
                </AlertDialog.Title>
              }
              footer={
                <>
                  <AlertDialog.Cancel asChild>
                    <SettingsButton disabled={busy}>
                      {f("cancel")}
                    </SettingsButton>
                  </AlertDialog.Cancel>
                  <SettingsButton
                    variant="danger"
                    disabled={busy}
                    onClick={() => {
                      if (deletion)
                        void request({
                          action:
                            deletion.kind === "connection"
                              ? "delete-credential"
                              : "delete-environment",
                          id: deletion.id,
                          revision: deletion.revision,
                          source: deletion.source,
                        }).then((next) => {
                          if (next) {
                            setDeletion(undefined);
                            setDraft(undefined);
                            setNotice(f("saved"));
                          }
                        });
                    }}
                  >
                    {f("confirmDelete")}
                  </SettingsButton>
                </>
              }
            >
              <AlertDialog.Description>
                {deletion?.name} —{" "}
                {f(
                  deletion?.kind === "connection"
                    ? "deleteConnection"
                    : "deleteEnvironment",
                )}
              </AlertDialog.Description>
              {deletion?.source === "platform" ? (
                <p className="join-assets__subtle">{f("platformRemoval")}</p>
              ) : null}
              {error ? (
                <SettingsNotice tone="error">{error}</SettingsNotice>
              ) : null}
            </SettingsPanel>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      <AlertDialog.Root
        open={rotation}
        onOpenChange={(open) => {
          if (!open && !busy) setRotation(false);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay
            className="modal-surface__scrim"
            data-layer="confirmation"
            data-appearance="utility"
          />
          <AlertDialog.Content
            className="modal-surface"
            data-layer="confirmation"
            data-appearance="utility"
            data-size="compact"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              closeConfirmation();
            }}
          >
            <SettingsPanel
              title={
                <AlertDialog.Title asChild>
                  <span>
                    {f(platformEditor ? "publicationTitle" : "rotationTitle")}
                  </span>
                </AlertDialog.Title>
              }
              footer={
                <>
                  <AlertDialog.Cancel asChild>
                    <SettingsButton disabled={busy}>
                      {f("cancel")}
                    </SettingsButton>
                  </AlertDialog.Cancel>
                  <SettingsButton
                    variant="danger"
                    disabled={busy}
                    onClick={() => void save(true)}
                  >
                    {f(
                      platformEditor ? "confirmPublication" : "confirmRotation",
                    )}
                  </SettingsButton>
                </>
              }
            >
              <AlertDialog.Description>
                {f(platformEditor ? "publicationAbout" : "rotationAbout")}
              </AlertDialog.Description>
              {editorUsage.length ? (
                <p className="join-assets__subtle">
                  {editorUsage.map((e) => e.name).join(" · ")}
                </p>
              ) : null}
              {error ? (
                <SettingsNotice tone="error">{error}</SettingsNotice>
              ) : null}
            </SettingsPanel>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
      <AlertDialog.Root
        open={discard}
        onOpenChange={(open) => {
          if (!open) {
            cancelLeave.current?.();
            cancelLeave.current = null;
            setDiscard(false);
          }
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay
            className="modal-surface__scrim"
            data-layer="confirmation"
            data-appearance="utility"
          />
          <AlertDialog.Content
            className="modal-surface"
            data-layer="confirmation"
            data-appearance="utility"
            data-size="compact"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!discard) closeConfirmation();
            }}
          >
            <SettingsPanel
              title={
                <AlertDialog.Title asChild>
                  <span>{f("discardTitle")}</span>
                </AlertDialog.Title>
              }
              footer={
                <>
                  <AlertDialog.Cancel asChild>
                    <SettingsButton>{f("keepEditing")}</SettingsButton>
                  </AlertDialog.Cancel>
                  <SettingsButton
                    variant="danger"
                    onClick={() => {
                      const action = pendingNavigation.current;
                      cancelLeave.current = null;
                      setDiscard(false);
                      // Local discard actions may enter the router synchronously.
                      // The consent covers only this attempt, never a later action.
                      leaveBypass.current = true;
                      try {
                        action();
                      } finally {
                        leaveBypass.current = false;
                      }
                    }}
                  >
                    {f("discard")}
                  </SettingsButton>
                </>
              }
            >
              <AlertDialog.Description>
                {f("discardAbout")}
              </AlertDialog.Description>
            </SettingsPanel>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </SettingsCollectionDocument>
  );
}
