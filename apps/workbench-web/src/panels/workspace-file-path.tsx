import { Fragment } from "react";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { Button, DisclosureButton } from "@opencraft/design-system-web/button";
import { ChevronRightIcon, MoreIcon } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import { workspaceBreadcrumbs } from "./workspace-resource-model";

/** Ancestor navigation; the current file or directory is already in the header. */
export function WorkspaceFilePath({ path, scopeRoot, onSelect }: { path: string; scopeRoot?: string; onSelect(path: string): void }) {
  const intl = useIntl();
  const parts = workspaceBreadcrumbs(path, scopeRoot);
  const hidden = parts.slice(0, -2);
  const visible = parts.slice(-2);
  const label = intl.formatMessage({ id: "files.path", defaultMessage: "File path" });
  if (!parts.length) return null;
  return <nav className="workspace-file-path" aria-label={label}>
    {hidden.length > 0 ? <>
      <DropdownMenu.Root key={path}>
        <DropdownMenu.Trigger asChild><DisclosureButton className="workspace-file-path__overflow" aria-label={label}><MoreIcon size={16} /></DisclosureButton></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="workspace-file-menu" align="start" sideOffset={4}>
          {hidden.map(part => <DropdownMenu.Item className="workspace-file-menu__item" key={part.path} title={part.path} onSelect={() => onSelect(part.path)}>{part.label}</DropdownMenu.Item>)}
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ChevronRightIcon className="workspace-file-path__separator" size={12} aria-hidden="true" />
    </> : null}
    {visible.map((part, index) => <Fragment key={part.path}>
      {index > 0 ? <ChevronRightIcon className="workspace-file-path__separator" size={12} aria-hidden="true" /> : null}
      <Button variant="ghost" size="sm" title={part.path} onClick={() => onSelect(part.path)}>{part.label}</Button>
    </Fragment>)}
  </nav>;
}
