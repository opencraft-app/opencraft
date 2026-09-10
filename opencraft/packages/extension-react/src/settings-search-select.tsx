import * as Popover from "@radix-ui/react-popover";
import React, { useId, useRef, useState, type ReactNode } from "react";

export interface SettingsChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: ReactNode;
  readonly badge?: string;
}
export interface SettingsChoiceGroup {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly options: readonly SettingsChoice[];
}

/** Settings owns search, focus and layout. Plugins supply data and selection. */
export function SettingsSearchSelect({ id, label, value, groups, disabled, onChange }: {
  id: string; label: string; value: string; groups: readonly SettingsChoiceGroup[];
  disabled?: boolean; onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const selected = groups.flatMap(group => group.options).find(option => option.value === value);
  const selectedGroup = groups.find(group => group.options.some(option => option.value === value));
  const needle = query.trim().toLocaleLowerCase();
  const filtered = groups.map(group => ({ ...group, options: group.options.filter(option =>
    `${group.label} ${option.label} ${option.value} ${option.description ?? ""}`.toLocaleLowerCase().includes(needle))
  })).filter(group => group.options.length > 0);
  return <Popover.Root open={open && !disabled} onOpenChange={next => { setOpen(next); setQuery(""); }}>
    <Popover.Trigger asChild>
      <button id={id} type="button" className="settings-search-select__trigger" disabled={disabled}>
        {selected?.icon}<span className="settings-search-select__copy"><strong>{selected?.label ?? (value ? "Selection unavailable" : `Select ${label.toLowerCase()}`)}</strong>
          {selectedGroup ? <small>{selectedGroup.label}</small> : null}</span>
        <span aria-hidden="true">⌄</span>
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="settings-search-select" align="end" sideOffset={6} collisionPadding={8}
        aria-labelledby={headingId} onOpenAutoFocus={event => { event.preventDefault(); search.current?.focus(); }}>
        <h3 id={headingId} className="settings-search-select__heading">{label}</h3>
        <input ref={search} className="settings-search-select__search" type="search"
          aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}…`}
          value={query} onChange={event => setQuery(event.target.value)} />
        <div className="settings-search-select__results">
          {filtered.length === 0 ? <p role="status">{groups.some(g => g.options.length) ? "No matches" : "No options available"}</p> : filtered.map(group =>
            <section key={group.id} aria-label={group.label}>
              <div className="settings-search-select__group">{group.icon}<span>{group.label}</span></div>
              {group.options.map(option => <button type="button" key={option.value}
                className="settings-search-select__option" aria-pressed={option.value === value}
                onClick={() => { onChange(option.value); setOpen(false); setQuery(""); }}>
                {option.icon}<span className="settings-search-select__copy"><strong>{option.label}</strong>
                  {option.description ? <small>{option.description}</small> : null}</span>
                {option.badge ? <small className="settings-search-select__badge">{option.badge}</small> : null}
                <span className="settings-search-select__check" aria-hidden="true">{option.value === value ? "✓" : ""}</span>
              </button>)}
            </section>)}
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
