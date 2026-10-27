import { useEffect, useRef } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { useAsyncNotices } from "./async-notices-context";

/** Failed continuation does not become content in the floating Composer layer. */
export function ContinuationFailureNotice({ scope, error }: {
  readonly scope: string;
  readonly error: Error | null | undefined;
}) {
  const intl = useIntl();
  const notices = useAsyncNotices();
  const reported = useRef<{ scope: string; error: Error } | null>(null);
  useEffect(() => {
    if (!error) { reported.current = null; return; }
    if (reported.current?.scope === scope && reported.current.error === error) return;
    reported.current = { scope, error };
    notices.error({ key: `continue:${scope}`, message: intl.formatMessage({
      id: "chat.continue.failed", defaultMessage: "Could not confirm the continuation. Check the conversation before retrying.",
    }) });
  }, [scope, error, intl, notices]);
  return null;
}
