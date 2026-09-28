import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { ChevronRight, ExternalLink, LoaderCircle, Plug, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { SettingsTextInput } from "@opencraft/extension-react";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";

import { ConnectorBrand } from "./connector-brand";

export interface ConnectorQuickItem {
  readonly id: string;
  readonly title: string;
  readonly brandId: string | null;
  readonly phase: string;
  readonly status: string;
  readonly selected: boolean;
  readonly switchState: boolean | null;
  readonly actionable: boolean;
  readonly busy: boolean;
  readonly error: string | null;
}

interface ConnectorQuickMenuProps {
  readonly items: readonly ConnectorQuickItem[];
  readonly onAction: (item: ConnectorQuickItem) => void;
  readonly onManage: (() => void) | undefined;
  readonly inDropdownMenu?: boolean;
  readonly onAfterAction?: () => void;
}

function ConnectorIdentity({ item }: { readonly item: ConnectorQuickItem }) {
  return item.brandId === null ? (
    <span className="connector-quick-identity connector-quick-identity--fallback" aria-hidden="true">
      <Plug size={14} />
    </span>
  ) : (
    <span className="connector-quick-identity" aria-hidden="true">
      <ConnectorBrand id={item.brandId} />
    </span>
  );
}

export function ConnectorQuickMenu({ items, onAction, onManage, inDropdownMenu = false, onAfterAction }: ConnectorQuickMenuProps) {
  const intl = useIntl();
  const [query, setQuery] = useState("");
  const initialOrder = useRef<readonly string[] | null>(null);
  if (initialOrder.current === null && items.length > 0) initialOrder.current = items.map(item => item.id);
  const orderedItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle) return items.filter(item => item.title.toLocaleLowerCase().includes(needle));
    const byId = new Map(items.map(item => [item.id, item]));
    const ordered: ConnectorQuickItem[] = [];
    for (const id of initialOrder.current ?? []) {
      const item = byId.get(id);
      if (item !== undefined) { ordered.push(item); byId.delete(id); }
    }
    ordered.push(...byId.values());
    return ordered;
  }, [items, query]);

  return <div className="connector-quick-menu">
    {items.length > 5 ? <label className="connector-quick-menu__search">
      <Search size={14} aria-hidden="true" />
      <SettingsTextInput
        aria-label={intl.formatMessage({ id: "connector.search", defaultMessage: "Search connectors" })}
        placeholder={intl.formatMessage({ id: "connector.search.placeholder", defaultMessage: "Search connectors…" })}
        value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation(); }}
      />
    </label> : null}
    <div className="connector-quick-menu__list" role="group" aria-label={intl.formatMessage({ id: "connector.session", defaultMessage: "Conversation connectors" })}>
      {orderedItems.map(item => {
        const row = <button
          type="button"
          className="connector-quick-menu__row"
          data-phase={item.phase}
          data-selected={item.selected || undefined}
          disabled={!item.actionable}
          role={item.switchState === null ? undefined : "switch"}
          aria-checked={item.switchState ?? undefined}
          aria-busy={item.busy || undefined}
          aria-label={`${item.title}，${item.status}`}
          onClick={() => { onAction(item); onAfterAction?.(); }}
        >
          <ConnectorIdentity item={item} />
          <span className="connector-quick-menu__name">{item.title}</span>
          <span className="connector-quick-menu__status" aria-hidden="true">
            {item.busy ? <LoaderCircle className="is-spinning" size={14} /> : null}
            <span>{item.status}</span>
          </span>
          {item.switchState === null ? null : <span className="connector-quick-menu__switch" data-state={item.switchState ? "on" : "off"} aria-hidden="true"><span /></span>}
        </button>;
        return <div className="connector-quick-menu__entry" key={item.id}>
        {inDropdownMenu ? <DropdownMenu.Item asChild>{row}</DropdownMenu.Item> : row}
        {item.error ? <p className="connector-quick-menu__error" role="alert">{item.error}</p> : null}
      </div>;
      })}
      {orderedItems.length === 0 ? <div className="connector-quick-menu__empty">{query
        ? <FormattedMessage id="connector.emptySearch" defaultMessage="No matching connectors" />
        : <FormattedMessage id="connector.empty" defaultMessage="No connectors configured" />}</div> : null}
    </div>
    {onManage ? <>
      <div className="connector-quick-menu__separator" role="separator" />
      {inDropdownMenu ? <DropdownMenu.Item asChild><button type="button" className="connector-quick-menu__manage" onClick={() => { onManage(); onAfterAction?.(); }}>
        <ExternalLink size={14} aria-hidden="true" />
        <span><FormattedMessage id="connector.manage" defaultMessage="Manage connectors" /></span>
      </button></DropdownMenu.Item> : <button type="button" className="connector-quick-menu__manage" onClick={onManage}>
        <ExternalLink size={14} aria-hidden="true" />
        <span><FormattedMessage id="connector.manage" defaultMessage="Manage connectors" /></span>
      </button>}
    </> : null}
  </div>;
}

export function ConnectorAddMenuItem({ items, onAction, onManage, portalContainer, onAfterAction }: ConnectorQuickMenuProps & { readonly portalContainer: HTMLElement | null }) {
  return <DropdownMenu.Sub>
    <DropdownMenu.SubTrigger className="codex-composer-selection-menu__item codex-composer-add-menu__item">
      <Plug size={15} aria-hidden="true" />
      <span><FormattedMessage id="connector.title" defaultMessage="Connectors" /></span>
      <ChevronRight className="codex-composer-add-menu__chevron" size={14} aria-hidden="true" />
    </DropdownMenu.SubTrigger>
    <DropdownMenu.Portal container={portalContainer}>
      <DropdownMenu.SubContent className="connector-quick-surface connector-quick-surface--submenu" sideOffset={4} collisionPadding={8}>
        <ConnectorQuickMenu items={items} onAction={onAction} onManage={onManage} inDropdownMenu onAfterAction={onAfterAction} />
      </DropdownMenu.SubContent>
    </DropdownMenu.Portal>
  </DropdownMenu.Sub>;
}

export function ConnectorStatusChip({ activeItems, items, onAction, onManage, portalContainer }: ConnectorQuickMenuProps & {
  readonly activeItems: readonly ConnectorQuickItem[];
  readonly portalContainer: HTMLElement | null;
}) {
  const intl = useIntl();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (activeItems.length === 0) return null;
  const visible = activeItems.slice(0, 3);
  return <Popover.Root open={open} onOpenChange={next => {
    setOpen(next);
    if (!next) setTimeout(() => triggerRef.current?.focus(), 0);
  }}>
    <Popover.Trigger asChild>
      <button ref={triggerRef} type="button" className="connector-status-chip" aria-label={intl.formatMessage(
        { id: "connector.current", defaultMessage: "Conversation connectors: {names}" },
        { names: activeItems.map(item => item.title).join(", ") },
      )}>
        <span className="connector-status-chip__stack" aria-hidden="true">
          {visible.map(item => <ConnectorIdentity item={item} key={item.id} />)}
        </span>
        {activeItems.length > visible.length ? <span className="connector-status-chip__count">+{activeItems.length - visible.length}</span> : null}
      </button>
    </Popover.Trigger>
    <Popover.Portal container={portalContainer}>
      <Popover.Content className="connector-quick-surface connector-quick-surface--chip" align="end" side="top" sideOffset={6} collisionPadding={8}
        onCloseAutoFocus={event => { event.preventDefault(); triggerRef.current?.focus(); }}>
        <ConnectorQuickMenu items={items} onAction={onAction} onManage={onManage} />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
