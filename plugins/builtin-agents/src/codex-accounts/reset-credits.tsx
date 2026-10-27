import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { SettingsButton, SettingsListItem, type ExtensionSettingsViewProps } from "@opencraft/extension-react";
import type { CodexAccountView, CodexResetCreditsView, CodexResetCreditView } from "@opencraft/appserver-protocol";
import type { CodexAccountsService } from "./service.js";
import { maskAccountDisplayIdentity } from "./identity.js";
import { resetCreditMessages as messages } from "./reset-credit-messages.js";

export function ResetCredits({ account, service, reportError }: {
  readonly account: CodexAccountView;
  readonly service: CodexAccountsService;
  readonly reportError?: ExtensionSettingsViewProps["reportError"];
}) {
  const intl = useIntl();
  const f = intl.formatMessage;
  const [details, setDetails] = useState<CodexResetCreditsView | null>(null);
  const [pending, setPending] = useState<"read" | "use" | null>(null);
  const [selected, setSelected] = useState<CodexResetCreditView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const lease = useRef(0);
  const busy = useRef(false);
  useEffect(() => () => { lease.current++; }, [account.id, service]);
  const expires = (credit: CodexResetCreditView) => !credit.expiryKnown ? f(messages.unknownExpiry)
    : credit.expiresAt === null ? f(messages.noExpiry)
      : f(messages.expires, { date: intl.formatDate(credit.expiresAt, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) });
  const usable = (credit: CodexResetCreditView) => account.enabled && credit.status === "available" && credit.supportedByPlan
    && credit.resetType === "codex_rate_limits" && credit.expiryKnown && (credit.expiresAt === null || credit.expiresAt > Date.now());
  const status = (credit: CodexResetCreditView) => credit.expiresAt !== null && credit.expiresAt <= Date.now() ? f(messages.expired)
    : credit.status === "redeeming" ? f(messages.redeeming) : credit.status === "redeemed" ? f(messages.redeemed)
      : usable(credit) ? f(messages.available) : f(messages.unavailable);
  const run = async (kind: "read" | "use") => {
    if (busy.current || (kind === "use" && !selected)) return;
    busy.current = true;
    const generation = ++lease.current;
    setPending(kind);
    try {
      if (kind === "read") {
        const result = await service.listResetCredits(account.id);
        if (generation !== lease.current) return;
        setDetails(result); setNotice(null); setUncertain(false);
      } else {
        const result = await service.consumeResetCredit(account.id, selected!.id);
        if (generation !== lease.current) return;
        setSelected(null);
        if (result.credits) setDetails(result.credits);
        const unknown = result.outcome === "unknown";
        setUncertain(unknown);
        const message = f(result.outcome === "reset" && !result.usageRefreshed ? messages.refreshNeeded : messages[result.outcome]);
        setNotice(message);
        if (unknown) reportError?.({ key: `codex-reset:${account.id}`, message });
      }
    } catch {
      if (generation !== lease.current) return;
      // A failed consume RPC can have lost a committed reply. Require a read,
      // preserve its retry key in the service, and never report success.
      setSelected(null);
      if (kind === "use") { setUncertain(true); setNotice(f(messages.unknown)); }
      reportError?.({ key: `codex-reset:${account.id}`, message: f(kind === "use" ? messages.unknown : messages.failed) });
    } finally {
      busy.current = false;
      if (generation === lease.current) setPending(null);
    }
  };
  return <section className="engine-reset-credits" aria-label={f(messages.heading)} aria-busy={pending !== null}>
    <SettingsListItem label={f(messages.heading)} description={notice ?? (details?.credits.length === 0 ? f(messages.empty) : f(messages.description))} actions={
      <SettingsButton disabled={pending !== null} onClick={() => { void run("read"); }}>
        {pending === "read" ? f(messages.loading) : details ? f(messages.refresh) : f(messages.view)}
      </SettingsButton>
    } />
    {details?.credits.map(credit => <SettingsListItem key={credit.id} label={credit.title ?? f(messages.credit)}
      description={`${status(credit)} · ${expires(credit)}`} metadata={f(messages.id, { id: credit.id })} actions={
      <SettingsButton disabled={pending !== null || uncertain || !usable(credit)} onClick={() => setSelected(credit)}>{f(messages.use)}</SettingsButton>
    } />)}
    <AlertDialog.Root open={selected !== null} onOpenChange={open => { if (!open && !busy.current) setSelected(null); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="engine-account-dialog__overlay" />
        <AlertDialog.Content className="engine-account-dialog engine-account-dialog--compact">
          <AlertDialog.Title>{f(messages.confirm)}</AlertDialog.Title>
          <AlertDialog.Description>{f(messages.confirmation, { account: maskAccountDisplayIdentity(account.label) })}</AlertDialog.Description>
          {selected ? <p className="engine-reset-credits__metadata"><span>{expires(selected)}</span><span>{f(messages.id, { id: selected.id })}</span></p> : null}
          <footer>
            <AlertDialog.Cancel asChild><SettingsButton disabled={pending !== null}>{f(messages.cancel)}</SettingsButton></AlertDialog.Cancel>
            <SettingsButton variant="primary" disabled={pending !== null || !selected || !usable(selected)} onClick={() => { void run("use"); }}>
              {pending === "use" ? f(messages.working) : f(messages.use)}
            </SettingsButton>
          </footer>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  </section>;
}
