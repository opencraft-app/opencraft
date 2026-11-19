import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { AvatarImage, type ThreadBadgeContribution, type ThreadBadgeProps } from "@opencraft/extension-react";
import { PersonIcon as UserRound } from "@opencraft/design-system-web/action-icons";
import { employeePhotoUrl } from "./photo";
import type { TencentOaParticipantsController } from "./participants-controller";
import { useIntl } from "@opencraft/i18n/react";
import "./participants.scss";

function EmployeeAvatar({ name, overlap = false }: { name: string; overlap?: boolean }) {
  return <span className="ioa-participants__avatar" data-overlap={overlap || undefined} aria-hidden="true">
    <AvatarImage src={employeePhotoUrl(name)} fallback={<UserRound size={12} />} />
  </span>;
}

export function createParticipantsBadge(controller: TencentOaParticipantsController): ThreadBadgeContribution {
  function ParticipantsBadge({ hostId, threadId, open, onOpenChange, onCloseAutoFocus, portalContainer }: ThreadBadgeProps) {
    const intl = useIntl();
    const snapshot = useSyncExternalStore(controller.subscribe, () => controller.getSnapshot(hostId, threadId));
    useEffect(() => controller.watch(hostId, threadId), [hostId, threadId]);
    const hoverOpened = useRef(false);
    const hoverFocus = useRef(false);
    const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const cancelOpen = () => {
      clearTimeout(openTimer.current);
      openTimer.current = undefined;
    };
    const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const cancelClose = () => {
      clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    };
    const unsupported = snapshot.phase === "unsupported";
    useEffect(() => {
      if (!open) hoverOpened.current = false;
      cancelOpen();
      cancelClose();
      return () => { cancelOpen(); cancelClose(); };
    }, [open, hostId, threadId, unsupported]);
    const leaveHover = () => {
      cancelOpen();
      cancelClose();
      if (hoverOpened.current) closeTimer.current = setTimeout(() => onOpenChange(false), 150);
    };
    if (snapshot.phase === "unsupported") return null;
    const names = snapshot.data?.participants;
    const creator = snapshot.data?.creator;
    const otherParticipants = names?.filter(name => name !== creator);
    const people = creator && !names?.includes(creator) ? [creator, ...(names ?? [])] : (names ?? []);
    const latest = people.at(-1);
    const visiblePeople = people.slice(-1);
    const countLabel = intl.formatNumber(people.length);
    const totalLabel = people.length > visiblePeople.length ? intl.formatMessage({
      id: "ioa.participants.total", defaultMessage: "{count} people",
    }, { count: people.length }) : null;
    return <Popover.Root open={open} onOpenChange={next => {
      cancelOpen();
      hoverOpened.current = false;
      if (next) hoverFocus.current = false;
      cancelClose();
      onOpenChange(next);
    }}>
      <Popover.Trigger asChild><button type="button" className="ioa-participants__badge"
        onPointerEnter={event => {
          if (event.pointerType !== "mouse") return;
          cancelClose();
          cancelOpen();
          // Let the pointer cross the sidebar without opening a secondary surface.
          if (!open) {
            openTimer.current = setTimeout(() => {
              openTimer.current = undefined;
              hoverOpened.current = true;
              hoverFocus.current = true;
              onOpenChange(true);
            }, 600);
          }
        }}
        onPointerLeave={leaveHover}
        onPointerCancel={leaveHover}
        onPointerDown={cancelOpen}
        onKeyDown={cancelOpen}
        onWheel={cancelOpen}
        onClick={event => {
          cancelOpen();
          // A click pins an already visible hover preview for normal dismissal.
          if (hoverOpened.current) {
            hoverOpened.current = false;
            hoverFocus.current = false;
            cancelClose();
            event.preventDefault();
          }
        }}
        aria-label={`${intl.formatMessage({ id: "ioa.participants.view", defaultMessage: "View conversation participants" })}${people.length ? ` (${intl.formatNumber(people.length)})` : ""}`}>
        <span className="ioa-participants__stack">
          {latest ? visiblePeople.map((name, index) => <EmployeeAvatar key={name} name={name} overlap={index > 0} />) : <span className="ioa-participants__avatar" aria-hidden="true"><UserRound size={12} /></span>}
        </span>
        {totalLabel ? <span className="ioa-participants__total" title={totalLabel}
          style={{ fontSize: `min(var(--typography-count-badge-size), ${25 / countLabel.length}px)` }}
          aria-hidden="true">{countLabel}</span> : null}
      </button></Popover.Trigger>
      <Popover.Portal container={portalContainer}><Popover.Content className="ioa-participants__popover" side="right" align="start" sideOffset={8} collisionPadding={12}
        onPointerEnter={cancelClose} onPointerLeave={leaveHover}
        onOpenAutoFocus={event => { if (hoverOpened.current) event.preventDefault(); }}
        onCloseAutoFocus={event => {
          if (hoverFocus.current) event.preventDefault();
          onCloseAutoFocus?.(event);
        }}>
        {creator ? <section className="ioa-participants__creator-section">
          <div className="ioa-participants__heading">{intl.formatMessage({ id: "ioa.participants.creator", defaultMessage: "Creator" })}</div>
          <div className="ioa-participants__creator"><EmployeeAvatar name={creator} /><span>{creator}</span></div>
        </section> : null}
        <div className="ioa-participants__heading">{intl.formatMessage({ id: "ioa.participants.heading", defaultMessage: "Participants" })}</div>
        {snapshot.phase === "error" ? <div className="ioa-participants__notice" role="status">{intl.formatMessage({ id: "ioa.participants.error", defaultMessage: "Unable to update participants" })} <button type="button" onClick={() => controller.refresh(hostId, threadId)}>{intl.formatMessage({ id: "ioa.participants.retry", defaultMessage: "Retry" })}</button></div> : null}
        {!names && snapshot.phase === "loading" ? <p role="status">{intl.formatMessage({ id: "ioa.participants.loading", defaultMessage: "Loading…" })}</p> : null}
        {otherParticipants && otherParticipants.length === 0 ? <p>{intl.formatMessage({ id: "ioa.participants.empty", defaultMessage: "No identified participants yet" })}</p> : null}
        {otherParticipants && otherParticipants.length > 0 ? <ul>{otherParticipants.map(name => <li key={name}><EmployeeAvatar name={name} /><span>{name}</span></li>)}</ul> : null}
      </Popover.Content></Popover.Portal>
    </Popover.Root>;
  }
  return { id: "tencentoa.identity.participants", placement: "title", Component: ParticipantsBadge };
}
