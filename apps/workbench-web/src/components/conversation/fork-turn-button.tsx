import { useRef, useState } from "react";
import { ForkIcon as GitFork } from "@opencraft/design-system-web/action-icons";
import { ProgressIndicator } from "@opencraft/design-system-web/progress";
import { useIntl } from "@opencraft/i18n/react";

/** A fork is a mutation with a possibly unknown outcome; never retry it automatically. */
export function ForkTurnButton({ fork }: { readonly fork: () => Promise<void> }) {
  const intl = useIntl();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = intl.formatMessage({ id: "conversation.forkFromTurn", defaultMessage: "Branch from here" });
  return <>
    <button data-turn-fork="" type="button" title={label} aria-label={label} aria-busy={busy || undefined} disabled={busy}
      onClick={() => {
        if (pending.current) return;
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
