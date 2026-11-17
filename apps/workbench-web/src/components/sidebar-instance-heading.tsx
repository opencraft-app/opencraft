import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "@opencraft/design-system-web/button";
import { EditIcon, ChevronDownIcon } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import { EntityRenameDialog } from "./conversation-rename-dialog";

/** Display-name editing retains the instance identity and its disclosure state. */
export function SidebarInstanceHeading({ name, collapsed, controls, onToggle, onRename }: {
  name: string; collapsed: boolean; controls: string; onToggle(): void;
  onRename(name: string): Promise<void>;
}) {
  const intl = useIntl();
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const saving = useRef(false);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const title = intl.formatMessage({id:"sidebar.instance.rename",defaultMessage:"Rename device"});
  const save = async (value: string) => {
    if (saving.current) return;
    saving.current = true; setPending(true); setFailed(false);
    try { await onRename(value); if (mounted.current) setDraft(null); }
    catch { if (mounted.current) setFailed(true); }
    finally { saving.current = false; if (mounted.current) setPending(false); }
  };
  return <>
    <div className="sidebar-instance-heading">
      <h3 className="sidebar-thread-group-heading"><Button variant="ghost" size="navigation" contentLayout="row" className="sidebar-instance-toggle"
        aria-expanded={!collapsed} aria-controls={controls} onClick={onToggle}>
        <span className="sidebar-thread-group-label">{name}</span><ChevronDownIcon size={12} className={collapsed ? "is-collapsed" : undefined}/>
      </Button></h3>
      <IconButton ref={opener} size="accessory" variant="ghost" aria-label={title} title={title} onClick={() => {setFailed(false);setDraft(name);}}><EditIcon size={14}/></IconButton>
    </div>
    {draft !== null ? <EntityRenameDialog value={draft} pending={pending} maxLength={80} title={title}
      nameLabel={intl.formatMessage({id:"sidebar.instance.name",defaultMessage:"Device name"})}
      error={failed ? intl.formatMessage({id:"sidebar.instance.renameFailed",defaultMessage:"Could not save the name. Your changes are kept; try again."}) : undefined}
      onChange={setDraft} onSubmit={value => void save(value)} onDismiss={() => {if (!saving.current) setDraft(null);}} returnFocus={() => opener.current}/> : null}
  </>;
}
