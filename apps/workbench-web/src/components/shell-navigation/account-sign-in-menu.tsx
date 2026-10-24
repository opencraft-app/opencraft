import { SettingsGearIcon } from "@opencraft/design-system-web/action-icons";
import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import { useIntl } from "@opencraft/i18n/react";
import { ArrowUpRightIcon as ArrowUpRight } from "@opencraft/design-system-web/action-icons";
import { useEffect, useState } from "react";
import { AccountLeadingVisual, shellAccountEntranceLabel, type ShellAccount, type ShellSignIn } from "./navigation-content";

/** Same provider-driven account entrance in fixed and floating Sidecars. */
export function AccountSignInMenu({ account, signIn, id, visible, container, onOpenSettings }: {
  account: ShellAccount;
  signIn: ShellSignIn;
  id: string;
  visible: boolean;
  container: HTMLElement | null;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  const intl = useIntl();
  const label = shellAccountEntranceLabel(account, intl)!;
  return <DropdownMenu.Root modal={false} open={visible && open} onOpenChange={setOpen}>
    <DropdownMenu.Trigger asChild>
      <button id={id} type="button" className="shell-navigation__entrance" data-surface="account"
        aria-label={label} title={label}>
        <AccountLeadingVisual account={account} />
        <span className="shell-navigation__name" aria-live="polite">{label}</span>
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal container={container}>
      <DropdownMenu.Content className="shell-sign-in-menu" aria-label="登录" side="top" align="start" sideOffset={8} collisionPadding={12}>
        {signIn.pending || signIn.error ? <>
          <DropdownMenu.Label className="shell-sign-in-menu__status" aria-live="polite">
            {signIn.error ?? "正在等待浏览器登录"}
          </DropdownMenu.Label>
          <DropdownMenu.Item className="shell-sign-in-menu__item" onSelect={signIn.retry}>重新登录</DropdownMenu.Item>
          <DropdownMenu.Item className="shell-sign-in-menu__item" onSelect={signIn.cancel}>取消登录</DropdownMenu.Item>
        </> : signIn.options.map(option => <DropdownMenu.Item key={option.id} className="shell-sign-in-menu__item"
          textValue={option.label} onSelect={() => signIn.select(option.id)}>
          <span className="shell-sign-in-menu__copy"><span>{option.label}</span><small>{option.description}</small></span>
          <ArrowUpRight aria-hidden="true" size={14} />
        </DropdownMenu.Item>)}
        <DropdownMenu.Separator className="shell-sign-in-menu__separator" />
        <DropdownMenu.Item className="shell-sign-in-menu__item" textValue="设置" onSelect={() => {
          setOpen(false);
          onOpenSettings();
        }}>
          <SettingsGearIcon aria-hidden="true" size={16} /><span>设置</span>
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
