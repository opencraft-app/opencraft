import * as Popover from "@radix-ui/react-popover";
import { useEffect, useSyncExternalStore, type CSSProperties } from "react";
import type { ThreadBadgeContribution, ThreadBadgeProps } from "@opencraft/extension-react";
import type { TencentOaParticipantsController } from "./participants-controller";
import { useIntl } from "@opencraft/i18n/react";
import participantStyles from "./participants.scss?inline";

export function createParticipantsBadge(controller: TencentOaParticipantsController): ThreadBadgeContribution {
  function ParticipantsBadge({ hostId, threadId, open, onOpenChange, onCloseAutoFocus, portalContainer }: ThreadBadgeProps) {
    const intl = useIntl();
    const snapshot = useSyncExternalStore(controller.subscribe, () => controller.getSnapshot(hostId, threadId));
    useEffect(() => controller.watch(hostId, threadId), [hostId, threadId]);
    if (snapshot.phase === "unsupported") return null;
    const names = snapshot.data?.participants;
    const label = names ? `+${names.length}` : snapshot.phase === "error" ? "?" : "…";
    return <><style>{participantStyles}</style><Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild><button type="button" className="ioa-participants__badge"
        aria-label={names ? intl.formatMessage({ id: "ioa.participants.viewCount", defaultMessage: "View {count} participants" }, { count: names.length }) : intl.formatMessage({ id: "ioa.participants.view", defaultMessage: "View conversation participants" })}
        style={{ "--ioa-participant-digits": label.length } as CSSProperties}>
        {label}
      </button></Popover.Trigger>
      <Popover.Portal container={portalContainer}><Popover.Content className="ioa-participants__popover" side="right" align="start" sideOffset={8} collisionPadding={12} onCloseAutoFocus={onCloseAutoFocus}>
        <div className="ioa-participants__heading">{intl.formatMessage({ id: "ioa.participants.heading", defaultMessage: "Participants" })}{names ? ` · ${names.length}` : ""}</div>
        <p className="ioa-participants__description">{intl.formatMessage({ id: "ioa.participants.description", defaultMessage: "Identified message senders" })}</p>
        {snapshot.phase === "error" ? <div className="ioa-participants__notice" role="status">{intl.formatMessage({ id: "ioa.participants.error", defaultMessage: "Unable to update participants" })} <button type="button" onClick={() => controller.refresh(hostId, threadId)}>{intl.formatMessage({ id: "ioa.participants.retry", defaultMessage: "Retry" })}</button></div> : null}
        {!names && snapshot.phase === "loading" ? <p role="status">{intl.formatMessage({ id: "ioa.participants.loading", defaultMessage: "Loading…" })}</p> : null}
        {names?.length === 0 ? <p>{intl.formatMessage({ id: "ioa.participants.empty", defaultMessage: "No identified participants yet" })}</p> : null}
        {names && names.length > 0 ? <ul>{names.map(name => <li key={name}>{name}</li>)}</ul> : null}
      </Popover.Content></Popover.Portal>
    </Popover.Root></>;
  }
  return { id: "tencentoa.identity.participants", Component: ParticipantsBadge };
}
