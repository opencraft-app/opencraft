import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { isTouchPresentation, subscribeTouchPresentation } from "@opencraft/design-system-web/input-presentation";
import { AgentBrandIcon, type AgentBrand } from "@opencraft/design-system-web/action-icons";
import {
  CheckIcon,
  SearchIcon,
  ModelIcon,
  LightningIcon,
  AddIcon,
  ResetIcon,
  ChevronRightIcon,
  CloudIcon,
  LaptopIcon,
  ServerIcon,
  WarningIcon,
} from "@opencraft/design-system-web/action-icons";
import { DiscreteSlider } from "@opencraft/design-system-web/discrete-slider";
import * as Menu from "@opencraft/design-system-web/dropdown-menu";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { modelChoiceFamilies, chooseFamilyModel } from "./model-choice-families";
import { modelEffortLabel } from "./model-choice-labels";
import { ModelCatalogStatus } from "./model-catalog-status";
import type {
  ComposerAgentCycleDirection,
  ComposerAgentModelGroup,
  ComposerAgentSetupEntry,
  ComposerModelOption,
  ComposerSelectionCatalog,
} from "./composer-editor";
import { composerAgentBrands } from "./agent-menu-sources";

const brands: Record<string, { brand: AgentBrand; name: string }> = composerAgentBrands;

const LazyValdiReadinessMount = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function ReadinessMount({ viewModel }: { readonly viewModel: import("@opencraft/design-system-web/valdi").AgentReadinessProps }) {
    return (
      <mod.ValdiSurface
        component={mod.AgentReadinessSurface}
        viewModel={viewModel}
        className="opencraft-composer-agent-readiness-surface"
        data-testid="composer-agent-readiness-surface"
      />
    );
  }
  return { default: ReadinessMount };
});

const NOOP_UNSUBSCRIBE = () => () => {};
const FALSE_VALUE = () => false;

function useComposerTouchDensity(): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => (typeof document === "undefined" ? NOOP_UNSUBSCRIBE() : subscribeTouchPresentation(document, onChange)),
    [],
  );
  const getSnapshot = useCallback(
    () => (typeof document === "undefined" ? false : isTouchPresentation(document)),
    [],
  );
  return useSyncExternalStore(subscribe, getSnapshot, FALSE_VALUE);
}

function isDarkRoot(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.documentElement;
  const theme = el.getAttribute("data-theme") ?? el.getAttribute("data-color-scheme") ?? "";
  if (theme.toLowerCase().includes("dark")) return true;
  if (theme.toLowerCase().includes("light")) return false;
  return el.classList.contains("dark");
}

function useComposerDarkMode(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-color-scheme", "class"] });
    return () => observer.disconnect();
  }, []);
  return useSyncExternalStore(subscribe, isDarkRoot, FALSE_VALUE);
}

function ComposerInlineAgentSetup({ setup }: { readonly setup: ComposerAgentSetupEntry }) {
  const intl = useIntl();
  const touch = useComposerTouchDensity();
  const dark = useComposerDarkMode();
  const [copied, setCopied] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const activity = setup.activity;

  const viewModel = useMemo((): import("@opencraft/design-system-web/valdi").AgentReadinessProps => {
    const running = activity?.phase === "running";
    const failed = activity?.phase === "failed";
    const statusTitle = running
      ? intl.formatMessage(
          activity.kind === "install"
            ? { id: "onboard.agent.installing", defaultMessage: "Installing…" }
            : activity.kind === "upgrade"
              ? { id: "onboard.agent.upgrading", defaultMessage: "Updating…" }
              : { id: "onboard.agent.signingIn", defaultMessage: "Finish signing in below" },
        )
      : failed
        ? intl.formatMessage(
            activity.kind === "install"
              ? { id: "onboard.agent.installFailed", defaultMessage: "Install didn't finish" }
              : activity.kind === "upgrade"
                ? { id: "onboard.agent.upgradeFailed", defaultMessage: "Update didn't finish" }
                : { id: "onboard.agent.signInFailed", defaultMessage: "Sign-in didn't finish" },
          )
        : !setup.installed
          ? intl.formatMessage({ id: "onboard.agent.notInstalled", defaultMessage: "Not installed" })
          : setup.authenticated === false
            ? intl.formatMessage({ id: "onboard.agent.signInNeeded", defaultMessage: "Not signed in" })
            : !setup.enabled
              ? intl.formatMessage({ id: "composer.agent.setup.disabledTitle", defaultMessage: "Disabled in settings" })
              : intl.formatMessage({ id: "onboard.agent.unknown", defaultMessage: "Couldn't check this agent" });

    const description = running && activity?.kind === "sign-in" && !activity.url
      ? intl.formatMessage({ id: "onboard.agent.waiting", defaultMessage: "Waiting for the sign-in link…" })
      : !setup.installed
        ? intl.formatMessage(
            { id: "composer.agent.setup.notInstalledDesc", defaultMessage: "Install {agent} on this machine to chat and run tasks directly from the composer." },
            { agent: setup.label },
          )
        : setup.authenticated === false
          ? intl.formatMessage(
              { id: "composer.agent.setup.signInDesc", defaultMessage: "Sign in to your {agent} account to load its available models." },
              { agent: setup.label },
            )
          : !setup.enabled
            ? intl.formatMessage(
                { id: "composer.agent.setup.disabledDesc", defaultMessage: "Enable {agent} to make its models selectable for new conversations." },
                { agent: setup.label },
              )
            : intl.formatMessage({ id: "settings.agents.loadFailed", defaultMessage: "Some agents could not be checked. Try checking again." });

    let primaryActionTitle: string | null = null;
    let onPrimaryAction: (() => void) | undefined;
    if (!running) {
      if (failed) {
        primaryActionTitle = intl.formatMessage({ id: "onboard.agent.retry", defaultMessage: "Retry" });
        onPrimaryAction = activity?.kind === "sign-in" ? setup.onSignIn : setup.onInstall;
      } else if (!setup.installed) {
        primaryActionTitle = setup.canInstallPackage
          ? intl.formatMessage({ id: "onboard.agent.install", defaultMessage: "Install" })
          : intl.formatMessage({ id: "composer.agent.setup.download", defaultMessage: "Install guide" });
        onPrimaryAction = setup.onInstall;
      } else if (setup.authenticated === false) {
        primaryActionTitle = intl.formatMessage({ id: "onboard.agent.signIn", defaultMessage: "Sign in" });
        onPrimaryAction = setup.onSignIn;
      } else if (!setup.enabled && setup.onEnable) {
        primaryActionTitle = intl.formatMessage({ id: "composer.agent.setup.enable", defaultMessage: "Enable agent" });
        onPrimaryAction = setup.onEnable;
      }
    }

    const secondaryActionTitle = running
      ? intl.formatMessage({ id: "onboard.agent.cancel", defaultMessage: "Cancel" })
      : setup.onRecheck
        ? intl.formatMessage({ id: "onboard.agent.recheck", defaultMessage: "Check again" })
        : null;
    const onSecondaryAction = running ? setup.onCancel : setup.onRecheck;

    return {
      id: `composer-readiness-${setup.id}`,
      agentName: setup.label,
      statusTitle,
      description,
      icon: !setup.installed ? "terminal" : setup.authenticated === false ? "user" : "bot",
      version: setup.version,
      account: setup.account,
      phase: running ? "running" : failed ? "failed" : "idle",
      errorMessage: failed ? activity?.message ?? null : null,
      primaryActionTitle,
      secondaryActionTitle,
      openLinkTitle: activity?.kind === "sign-in" && activity.url
        ? intl.formatMessage({ id: "onboard.agent.openLogin", defaultMessage: "Open sign-in page" })
        : null,
      userCode: activity?.kind === "sign-in" ? activity.userCode : null,
      copyCodeTitle: activity?.kind === "sign-in" && activity.userCode
        ? intl.formatMessage(
            copied
              ? { id: "onboard.agent.copied", defaultMessage: "Copied" }
              : { id: "onboard.agent.copyCode", defaultMessage: "Copy code" },
          )
        : null,
      awaitingCode: Boolean(activity?.awaitingCode && setup.onSubmitCode),
      authCodeValue: authCode,
      authCodePlaceholder: intl.formatMessage({ id: "onboard.agent.authCodePlaceholder", defaultMessage: "Paste authorization code or callback URL" }),
      submitCodeTitle: intl.formatMessage({ id: "onboard.agent.submitCode", defaultMessage: "Submit code" }),
      touch,
      dark,
      onPrimaryAction,
      onSecondaryAction,
      onOpenLink: activity?.url ? () => window.open(activity.url!, "_blank", "noopener,noreferrer") : undefined,
      onCopyCode: activity?.userCode
        ? () => {
            void navigator.clipboard.writeText(activity.userCode!).then(() => setCopied(true)).catch(() => setCopied(false));
          }
        : undefined,
      onAuthCodeChange: setAuthCode,
      onSubmitCode: setup.onSubmitCode
        ? () => {
            const trimmed = authCode.trim();
            if (!trimmed) return;
            setup.onSubmitCode!(trimmed);
            setAuthCode("");
          }
        : undefined,
    };
  }, [activity, authCode, copied, dark, intl, setup, touch]);

  return (
    <div
      className="opencraft-composer-model-browser__setup"
      onKeyDown={event => {
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      <Suspense fallback={<div className="opencraft-composer-selection-menu__status" role="status">{viewModel.statusTitle}</div>}>
        <LazyValdiReadinessMount viewModel={viewModel} />
      </Suspense>
    </div>
  );
}

function MachineGlyph({ role, isLocal }: { readonly role?: "local" | "server" | "cloud"; readonly isLocal?: boolean }) {
  const Icon = isLocal || role === "local" ? LaptopIcon : role === "cloud" ? CloudIcon : ServerIcon;
  return <Icon size={15} aria-hidden="true" />;
}

function depthFor(models: readonly ComposerModelOption[], selectedId: string | null, effort: string | null) {
  const families = modelChoiceFamilies(models);
  const family = families.find(item => item.models.some(model => model.value === selectedId || model.id === selectedId));
  const current = family?.models.find(model => model.value === selectedId || model.id === selectedId);
  const variants = family?.variants ?? [];
  const options = variants.length ? variants.map(variant => ({ value: variant.effort, label: variant.effort })) : current?.efforts ?? [];
  const active = variants.length
    ? variants.find(variant => variant.model.value === selectedId || variant.model.id === selectedId)?.effort ?? null
    : effort;
  const defaultEffort = variants.length ? variants.find(variant => variant.model.isDefault)?.effort ?? null : current?.defaultEffort ?? null;
  const fast = current?.serviceTiers?.find(tier => tier.id === "fast" || tier.name.toLowerCase() === "fast");
  return { family, current, variants, options, active, defaultEffort, fast, label: family?.label ?? current?.label ?? "" };
}

/** Browsing sources/search is local. Only an explicit choice writes a model. */
export function ComposerModelMenu({ catalog, selected, onSelect, effort, onEffortChange, serviceTier, onServiceTierChange,
  switchingAgentId, agentSelectionError, onConfigure, agentCycleRequest, preferEffortLayer, onEffortLayerArmed }: {
  readonly catalog?: ComposerSelectionCatalog;
  readonly selected: string | null;
  readonly onSelect: (model: ComposerModelOption, group?: ComposerAgentModelGroup) => void;
  readonly effort: string | null;
  readonly onEffortChange: (value: string) => void;
  readonly serviceTier: string | null;
  readonly onServiceTierChange: (value: string | null) => void;
  readonly switchingAgentId: string | null;
  readonly agentSelectionError: { id: string; message: string } | null;
  readonly onConfigure?: () => void;
  readonly agentCycleRequest?: { readonly direction: ComposerAgentCycleDirection; readonly nonce: number } | null;
  /** Existing threads and a new thread after its first model choice open on the slider. */
  readonly preferEffortLayer?: boolean;
  readonly onEffortLayerArmed?: () => void;
}) {
  const intl = useIntl();
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const apiLabel = intl.formatMessage({ id: "composer.model.api", defaultMessage: "API models" });
  const currentAgentId = catalog?.currentAgentId ?? null;
  const currentAgentLabel = catalog?.currentAgentLabel ?? null;
  const currentAgentFallbackLabel = currentAgentLabel
    || (currentAgentId === null ? "" : currentAgentId === "dsh" || currentAgentId === "api" ? apiLabel : brands[currentAgentId]?.name || currentAgentId);
  type GroupItem = Omit<ComposerAgentModelGroup, "select"> & { readonly select?: ComposerAgentModelGroup["select"] };
  const groups: readonly GroupItem[] = catalog?.agentGroups?.length ? catalog.agentGroups : [{ id: "active", label: "", active: true,
    models: catalog?.models ?? [], residentAgents: catalog?.residentAgents, loading: catalog?.isFetching, error: catalog?.modelError, errorKind: catalog?.modelErrorKind, retry: catalog?.retryModels }];
  type Source = {
    id: string;
    agentId: string | null;
    agentLabel: string;
    label: string;
    brand?: AgentBrand;
    group: GroupItem;
    models: ComposerModelOption[];
    setup?: ComposerAgentSetupEntry;
  };
  const sourceId = (groupId: string, agentId: string | null) => JSON.stringify([groupId, agentId]);
  const currentGroup = groups.find(group => group.active);
  const currentAgent = (item: Source) => currentAgentId !== null && item.group === currentGroup && item.agentId === currentAgentId;
  const machineOrder = new Map<string, number>();
  for (const group of groups) {
    const machineKey = group.machineId ?? group.id;
    if (!machineOrder.has(machineKey)) machineOrder.set(machineKey, machineOrder.size);
  }
  const multiMachine = machineOrder.size > 1 && groups.some(group => Boolean(group.machineLabel));
  const sources: Source[] = [];
  for (const group of groups) {
    const scoped = new Map<string | null, Source>();
    for (const model of group.models) {
      const identity = model.agentId ? brands[model.agentId] : undefined;
      const key = model.agentId ?? null;
      let source = scoped.get(key);
      if (!source) {
        const name = key === "dsh" ? apiLabel : model.agentLabel || group.label || intl.formatMessage({ id: "composer.agent.label", defaultMessage: "Agent" });
        source = {
          id: sourceId(group.id, key),
          agentId: key,
          agentLabel: name,
          label: !multiMachine && groups.length > 1 && group.label !== name ? `${name} · ${group.label}` : name,
          brand: identity?.brand,
          group,
          models: [],
        };
        scoped.set(key, source); sources.push(source);
      }
      source.models.push(model);
    }
    const groupResidents = group.residentAgents ?? (group.active ? catalog?.residentAgents : undefined) ?? [];
    for (const resident of groupResidents) {
      const existing = scoped.get(resident.engineId);
      if (existing) {
        existing.setup = resident;
        continue;
      }
      const identity = brands[resident.engineId];
      const item: Source = {
        id: sourceId(group.id, resident.engineId),
        agentId: resident.engineId,
        agentLabel: resident.label,
        label: !multiMachine && groups.length > 1 && group.label && group.label !== resident.label ? `${resident.label} · ${group.label}` : resident.label,
        brand: identity?.brand,
        group,
        models: [],
        setup: resident,
      };
      scoped.set(resident.engineId, item);
      sources.push(item);
    }
    if (!scoped.size && (currentAgentId === null || group !== currentGroup)
      && (group.loading || group.error || !catalog?.onConfigureAgents)) {
      const fallbackLabel = multiMachine ? apiLabel : (group.label || apiLabel);
      sources.push({ id: sourceId(group.id, null), agentId: null, agentLabel: apiLabel, label: fallbackLabel, group, models: [] });
    }
  }
  if (currentAgentId !== null && currentGroup && !sources.some(currentAgent)) {
    sources.push({
      id: sourceId(currentGroup.id, currentAgentId), agentId: currentAgentId,
      agentLabel: currentAgentFallbackLabel,
      label: currentAgentFallbackLabel,
      brand: brands[currentAgentId]?.brand, group: currentGroup, models: [],
    });
  }
  const brandOrder: Record<string, number> = { codex: 0, claude: 1, cursor: 2, codebuddy: 3, pi: 4 };
  sources.sort((left, right) => {
    const leftMachine = machineOrder.get(left.group.machineId ?? left.group.id) ?? 0;
    const rightMachine = machineOrder.get(right.group.machineId ?? right.group.id) ?? 0;
    if (leftMachine !== rightMachine) return leftMachine - rightMachine;
    return (brandOrder[left.brand ?? ""] ?? 5) - (brandOrder[right.brand ?? ""] ?? 5);
  });
  const hasSelection = (item: Source) => item.models.some(model => model.value === selected || model.id === selected);
  const selectedSource = sources.find(item => currentAgent(item) && hasSelection(item))
    ?? sources.find(item => item.group.active && (currentAgentId === null || item.agentId === null) && hasSelection(item))
    ?? sources.find(item => item.group.active && hasSelection(item));
  const depth = depthFor(selectedSource?.models ?? [], selected, effort);
  const hasDepth = depth.options.length > 0;
  const [browsing, setBrowsing] = useState<{ id: string; groupId: string } | null>(null);
  const [view, setView] = useState<"models" | "effort">(() => agentCycleRequest || !preferEffortLayer || !hasDepth ? "models" : "effort");
  const browse = (item: Source) => setBrowsing({ id: item.id, groupId: item.group.id });
  const source = sources.find(item => item.id === browsing?.id)
    ?? sources.find(item => item.group.id === browsing?.groupId && item.models.length > 0)
    ?? selectedSource
    ?? sources.find(item => currentAgent(item) && item.models.length > 0)
    ?? sources.find(item => item.group.active && item.models.length > 0)
    ?? sources.find(currentAgent)
    ?? sources.find(item => item.group.active) ?? sources[0];
  const lastCycleNonce = useRef(0);
  useEffect(() => { if (view === "effort" && !hasDepth) setView("models"); }, [view, hasDepth]);
  useEffect(() => {
    if (!agentCycleRequest || agentCycleRequest.nonce === lastCycleNonce.current || !source || sources.length === 0) return;
    lastCycleNonce.current = agentCycleRequest.nonce;
    const index = sources.findIndex(item => item.id === source.id);
    const next = sources[(index + agentCycleRequest.direction + sources.length) % sources.length];
    if (next) { browse(next); setQuery(""); setView("models"); }
  }, [agentCycleRequest, source, sources]);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const active = node.ownerDocument.activeElement;
    if (!(active instanceof Node) || !node.contains(active)) return;
    node.querySelector<HTMLElement>(view === "effort" ? '[role="slider"]' : 'input[type="search"]')?.focus({ preventScroll: true });
  }, [view]);
  const sourceIcon = (brand: AgentBrand | undefined) => brand
    ? <AgentBrandIcon agent={brand} size={16} />
    : <ModelIcon size={16} aria-hidden="true" />;
  if (!source) return <div className="opencraft-composer-model-browser" ref={root}>
    <ModelCatalogStatus emptyTitle={catalog?.agentsDisabled ? <FormattedMessage id="composer.agent.none" defaultMessage="No enabled agents have available models. Enable an agent or check its setup in settings." /> : undefined} emptyHint={catalog?.agentsDisabled ? null : undefined} />
    {catalog?.onConfigureAgents ? <Menu.Item className="opencraft-composer-selection-menu__item" onSelect={catalog.onConfigureAgents}><FormattedMessage id="composer.agent.manage" defaultMessage="Manage agents…" /></Menu.Item> : null}
    {onConfigure ? <Menu.Item className="opencraft-composer-selection-menu__item" onSelect={onConfigure}><FormattedMessage id="workIn.manageModels" defaultMessage="Manage models…" /></Menu.Item> : null}
  </div>;

  const machineSections = (() => {
    const sections = new Map<string, {
      key: string;
      label: string;
      role?: "local" | "server" | "cloud";
      isLocal?: boolean;
      isOrigin?: boolean;
      isActiveTarget: boolean;
      items: Source[];
    }>();
    for (const item of sources) {
      const key = item.group.machineId ?? item.group.id;
      const existing = sections.get(key);
      if (existing) {
        existing.items.push(item);
        if (item.group.active) existing.isActiveTarget = true;
      } else {
        sections.set(key, {
          key,
          label: item.group.machineLabel || item.group.label,
          role: item.group.machineRole,
          isLocal: item.group.isLocalMachine,
          isOrigin: item.group.isConversationMachine,
          isActiveTarget: Boolean(item.group.active),
          items: [item],
        });
      }
    }
    return [...sections.values()];
  })();
  const showMachineSections = machineSections.length > 1 && machineSections.some(section => Boolean(section.label));
  const selectedMachineKey = source.group.machineId ?? source.group.id;
  const selectedMachineSection = showMachineSections
    ? (machineSections.find(section => section.key === selectedMachineKey) ?? machineSections[0])
    : undefined;
  const visibleSources = selectedMachineSection ? selectedMachineSection.items : sources;

  const selectMachineSection = (section: (typeof machineSections)[number]) => {
    const matched = section.items.find(item => (source.brand && item.brand === source.brand) || item.agentLabel === source.agentLabel)
      ?? section.items.find(item => item.group.active && item.models.length > 0)
      ?? section.items.find(item => item.models.length > 0)
      ?? section.items[0];
    if (matched) {
      browse(matched);
      setQuery("");
    }
  };

  const families = modelChoiceFamilies(source.models);
  const selectedFamily = source === selectedSource ? families.find(family => family.models.some(model => model.value === selected || model.id === selected)) : undefined;
  const reasoningLabel = intl.formatMessage({ id: "chat.reasoning", defaultMessage: "Reasoning" });
  const matches = families.filter(family => `${family.label} ${family.models.map(model => model.value).join(" ")}`.toLocaleLowerCase(intl.locale).includes(query.trim().toLocaleLowerCase(intl.locale)));
  const searchLabel = intl.formatMessage({ id: "composer.model.search", defaultMessage: "Search models" });
  const choose = (model: ComposerModelOption) => {
    onSelect(model, catalog?.agentGroups?.length ? source.group as ComposerAgentModelGroup : undefined);
    onEffortLayerArmed?.();
    const next = depthFor(source.models, model.value, null);
    setView(next.options.length ? "effort" : "models");
  };
  const applyEffort = (value: string) => {
    const variant = depth.variants.find(item => item.effort === value);
    if (variant) choose(variant.model);
    else onEffortChange(value);
  };
  const startsNewThread = catalog?.agentContinuation?.startsNewThread === true;
  const tabName = (item: Source) => {
    const base = showMachineSections && selectedMachineSection?.label ? `${item.agentLabel} · ${selectedMachineSection.label}` : item.label;
    return currentAgent(item)
      ? intl.formatMessage({ id: "composer.agent.tabCurrent", defaultMessage: "Agent: {agent}, current conversation" }, { agent: base })
      : intl.formatMessage({ id: "composer.agent.tabName", defaultMessage: "Agent: {agent}" }, { agent: base });
  };
  const showHandoffNotice = startsNewThread && currentAgentId !== null && source.agentId !== null && !currentAgent(source) && source.models.length > 0;
  const showInlineSetup = source.models.length === 0 && Boolean(source.setup);
  const fast = depth.fast;
  const showEffort = view === "effort" && hasDepth;
  const modelButtonLabel = depth.label || intl.formatMessage({ id: "chat.model", defaultMessage: "Model" });
  return <div className="opencraft-composer-model-browser" ref={root} data-layer={showEffort ? "effort" : "models"} data-multi-machine={!showEffort && showMachineSections ? "true" : undefined}>
    {showEffort ? <div className="opencraft-composer-effort">
      <DiscreteSlider appearance="capsule" options={depth.options.map(option => ({ value: option.value, label: modelEffortLabel(intl, option.value, option.label) }))}
        value={depth.active} label={reasoningLabel}
        unsetLabel={intl.formatMessage({ id: "composer.effort.unset", defaultMessage: "Select reasoning" })}
        disabled={!!switchingAgentId || depth.current?.policyRestricted === true}
        preservePointerFocus={() => root.current?.ownerDocument.activeElement instanceof HTMLElement
          && root.current.ownerDocument.activeElement.classList.contains("opencraft-composer-editor")}
        onValueChange={applyEffort}
        renderValue={label => <div className="opencraft-composer-effort__header">
          <span className="opencraft-composer-effort__side">{fast ? <IconButton size="accessory" variant="ghost" aria-pressed={serviceTier === fast.id}
            aria-label={intl.formatMessage({ id: "composer.model.fastMode", defaultMessage: "Fast mode" })}
            disabled={!!switchingAgentId} onClick={() => onServiceTierChange(serviceTier === fast.id ? null : fast.id)}>
            <LightningIcon size={16} filled={serviceTier === fast.id} aria-hidden="true" />
          </IconButton> : null}</span>
          <span className="opencraft-composer-effort__titles">
            <span className="opencraft-composer-effort__name">{label}</span>
            <Button className="opencraft-composer-effort__model" size="sm" density="compact" variant="ghost" aria-label={intl.formatMessage({ id: "composer.model.change", defaultMessage: "Change model, {model}" }, { model: modelButtonLabel })}
              onClick={() => setView("models")}>
              <span>{modelButtonLabel}</span><ChevronRightIcon size={14} aria-hidden="true" />
            </Button>
          </span>
          <span className="opencraft-composer-effort__side">{depth.defaultEffort && depth.options.some(option => option.value === depth.defaultEffort) ? <IconButton size="accessory" variant="ghost"
            aria-label={intl.formatMessage({ id: "composer.resetEffort", defaultMessage: "Reset reasoning to model default" })}
            disabled={!!switchingAgentId || depth.defaultEffort === depth.active || depth.current?.policyRestrictedEfforts?.includes(depth.defaultEffort)}
            onClick={() => { if (depth.defaultEffort) applyEffort(depth.defaultEffort); }}>
            <ResetIcon size={14} aria-hidden="true" />
          </IconButton> : null}</span>
        </div>} />
    </div> : <>
    {showMachineSections ? <div className="opencraft-composer-model-browser__machine-well">
      <div className="opencraft-composer-model-browser__machine-tabs" role="tablist"
        aria-label={intl.formatMessage({ id: "composer.model.machineSection", defaultMessage: "Execution machine" })}>
        {machineSections.map(section => {
          const isSelectedMachine = selectedMachineSection?.key === section.key;
          const badgeTone = isSelectedMachine && section.isActiveTarget ? "current" : "neutral";
          return <button key={section.key} type="button" role="tab" aria-selected={isSelectedMachine}
            data-machine-tab={section.key} data-value={section.key}
            data-current-machine={section.isOrigin ? "true" : undefined}
            data-active-target={section.isActiveTarget ? "true" : undefined}
            tabIndex={isSelectedMachine ? 0 : -1} title={section.label}
            className="opencraft-composer-model-browser__machine-tab"
            onMouseDown={event => { if (event.button === 0) event.preventDefault(); }}
            onClick={() => selectMachineSection(section)}
            onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault(); event.stopPropagation();
              const index = machineSections.findIndex(entry => entry.key === section.key);
              if (index < 0) return;
              const next = event.key === "Home" ? 0 : event.key === "End" ? machineSections.length - 1
                : (index + (event.key === "ArrowLeft" ? -1 : 1) + machineSections.length) % machineSections.length;
              selectMachineSection(machineSections[next]!);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[data-machine-tab]')[next]?.focus();
            }}>
            <span className="opencraft-composer-model-browser__machine-icon" aria-hidden="true">
              <MachineGlyph role={section.role} isLocal={section.isLocal} />
            </span>
            <span className="opencraft-composer-model-browser__machine-name">{section.label}</span>
            <span className="opencraft-composer-model-browser__machine-badge" data-tone={badgeTone}>
              {section.isLocal
                ? <FormattedMessage id="composer.model.localMachine" defaultMessage="Local" />
                : <FormattedMessage id="settings.agents.remote" defaultMessage="Remote" />}
            </span>
          </button>;
        })}
      </div>
    </div> : null}
    <div className="opencraft-composer-model-browser__sources-section">
      <div className="opencraft-composer-model-browser__sources" role="tablist" aria-label={intl.formatMessage({ id: "composer.agent.label", defaultMessage: "Agent" })}>
        {visibleSources.map(item => <Button key={item.id} size="sm" variant={source.id === item.id ? "secondary" : "ghost"} contentLayout="row"
          onMouseDown={event => { if (event.button === 0) event.preventDefault(); }}
          role="tab" aria-selected={source.id === item.id} tabIndex={source.id === item.id ? 0 : -1}
          data-unready={item.models.length === 0 && item.setup ? "true" : undefined}
          title={currentAgent(item)
            ? intl.formatMessage({ id: "composer.agent.currentTitle", defaultMessage: "{agent} (current conversation)" }, { agent: item.label })
            : (showMachineSections && selectedMachineSection?.label ? `${item.agentLabel} · ${selectedMachineSection.label}` : item.label)}
          aria-label={tabName(item)} data-current-agent={currentAgent(item) || undefined}
          onClick={() => { browse(item); setQuery(""); }} onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            const index = visibleSources.findIndex(candidate => candidate.id === item.id);
            const next = event.key === "Home" ? 0 : event.key === "End" ? visibleSources.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + visibleSources.length) % visibleSources.length;
            browse(visibleSources[next]!); setQuery("");
            event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
          }}>
          {sourceIcon(item.brand)}
          <span>{showMachineSections ? item.agentLabel : item.label}</span>
        </Button>)}
      </div>
    </div>
    {source.group.crossDevice && !selectedMachineSection?.isActiveTarget ? <div className="opencraft-composer-model-browser__cross-device-notice" role="note">
      <div className="opencraft-composer-model-browser__cross-device-head">
        <WarningIcon size={14} aria-hidden="true" />
        <div className="opencraft-composer-model-browser__cross-device-copy">
          <div className="opencraft-composer-model-browser__cross-device-desc">
            <FormattedMessage id="composer.model.crossMachineHint"
              defaultMessage="Only conversation context (JSONL) is synced. Execution machine and system environment will change, so tasks may not run as before." />
          </div>
        </div>
      </div>
    </div> : null}
    {showHandoffNotice ? <div className="opencraft-composer-selection-menu__status opencraft-composer-model-browser__handoff" role="status">
      <FormattedMessage id="composer.agent.newThreadNotice" defaultMessage="Choosing a model from another Agent starts a new conversation with this thread's context." />
    </div> : null}
    {showInlineSetup && source.setup ? (
      <ComposerInlineAgentSetup setup={source.setup} />
    ) : <>
    <label className="opencraft-composer-model-browser__search">
      <SearchIcon size={16} aria-hidden="true" />
      <input type="search" value={query} aria-label={searchLabel} placeholder={searchLabel} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === "Escape" || event.nativeEvent.isComposing) return;
          event.stopPropagation();
          if (event.key === "ArrowDown") { event.preventDefault(); event.currentTarget.closest('[role="menu"]')?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')?.focus(); }
        }} />
    </label>
    <div className="opencraft-composer-model-browser__models">
      <Menu.Label className="opencraft-composer-selection-menu__heading"><FormattedMessage id="chat.model" defaultMessage="Model" /></Menu.Label>
      {matches.map(family => <Menu.Item key={family.id} data-model-choice className="opencraft-composer-selection-menu__item"
        data-selected={family === selectedFamily || undefined} disabled={!!switchingAgentId || family.models.every(model => model.policyRestricted)}
        onSelect={event => { event.preventDefault(); choose(chooseFamilyModel(family, selected)); }}>
        <span className="opencraft-composer-selection-menu__copy"><span className="opencraft-composer-selection-menu__label">{family.label}</span></span>
        {family.models.some(model => model.configuredRole === "fallback") ? <span className="opencraft-composer-model-role"><FormattedMessage id="composer.model.fallbackShort" defaultMessage="Backup" /></span> : null}
        {family === selectedFamily ? <CheckIcon size={16} aria-hidden="true" /> : null}
      </Menu.Item>)}
      {query.trim() && !matches.length && families.length ? <div className="opencraft-composer-selection-menu__status"><FormattedMessage id="composer.model.noResults" defaultMessage="No models match your search." /></div> : null}
      {source.group.loading || source.group.error || source.models.length === 0 ? <ModelCatalogStatus loading={source.group.loading} error={!!source.group.error} errorKind={source.group.errorKind} retry={source.group.retry} /> : null}
      {switchingAgentId === source.group.id ? <div className="opencraft-composer-selection-menu__status" role="status"><FormattedMessage id="workIn.switchingAgent" defaultMessage="Switching Agent…" /></div> : null}
      {agentSelectionError?.id === source.group.id ? <div className="opencraft-composer-selection-menu__status is-error" role="alert">{agentSelectionError.message}</div> : null}
      {!source.group.loading && !source.group.error && source.models.length > 0 && selected !== null && !groups.some(group => group.active && group.models.some(model => model.value === selected || model.id === selected)) ? <div className="opencraft-composer-selection-menu__status is-error"><FormattedMessage id="composer.model.unavailable" defaultMessage="The selected model is unavailable. Choose another model." /></div> : null}
    </div>
    </>}
    {onConfigure ? <Menu.Item className="opencraft-composer-selection-menu__item opencraft-composer-model-browser__configure" onSelect={onConfigure}>
      <AddIcon size={16} aria-hidden="true" />{groups.find(group => group.active)?.models.length === 0
        ? <FormattedMessage id="composer.model.add" defaultMessage="Add a model…" />
        : <FormattedMessage id="workIn.manageModels" defaultMessage="Manage models…" />}
    </Menu.Item> : null}
    </>}
  </div>;
}
