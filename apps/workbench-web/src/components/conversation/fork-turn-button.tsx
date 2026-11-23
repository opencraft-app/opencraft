import { useRef, useState } from "react";
import { ForkIcon as GitFork } from "@opencraft/design-system-web/action-icons";
import { ProgressIndicator } from "@opencraft/design-system-web/progress";
import { useIntl } from "@opencraft/i18n/react";

/** A fork is a mutation with a possibly unknown outcome; never retry it automatically. */
export function ForkTurnButton({ fork, unsupported = false }: { readonly fork?: () => Promise<void>; readonly unsupported?: boolean }) {
  const intl = useIntl();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseLabel = intl.formatMessage({ id: "conversation.forkFromTurn", defaultMessage: "Branch from here" });
  const label = unsupported
    ? intl.formatMessage({ id: "agent.capability.unsupportedAction", defaultMessage: "{action} (Not supported by this agent)" }, { action: baseLabel })
    : baseLabel;
  return <>
    <button data-turn-fork="" data-unsupported={unsupported || undefined} type="button" title={label} aria-label={label} aria-busy={busy || undefined} disabled={unsupported || busy || !fork}
      onClick={() => {
        if (unsupported || !fork || pending.current) return;
        pending.current = true;
        setBusy(true);
        setError(null);
        void Promise.resolve().then(fork).catch(reason => {
          setError(reason instanceof Error ? reason.message : String(reason));
        }).finally(() => { pending.current = false; setBusy(false); });
      }}>
      {busy ? <ProgressIndicator /> : <GitFork size={13} />}
    </button>
    {error === null ? null : <span role="alert">{error}</span>}
  </>;
}
