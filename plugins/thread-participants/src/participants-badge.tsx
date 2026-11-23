import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  AvatarImage,
  useIdentityAvatarUrl,
  type ThreadBadgeContribution,
  type ThreadBadgeProps,
} from "@opencraft/extension-react";
import { DisclosureButton, InlineAction } from "@opencraft/design-system-web/button";
import { PersonIcon } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import { THREAD_PARTICIPANT_IDENTITY_KIND } from "./contract";
import type { ThreadParticipantsSource } from "./controller";
import "./participants.scss";

const HOVER_OPEN_MS = 600;
const HOVER_CLOSE_MS = 150;

function ParticipantAvatar({ name, overlap = false }: { name: string; overlap?: boolean }) {
  const src = useIdentityAvatarUrl(THREAD_PARTICIPANT_IDENTITY_KIND, name);
  return (
    <span className="thread-participants__avatar" data-overlap={overlap || undefined} aria-hidden="true">
      <AvatarImage src={src} fallback={<PersonIcon size={12} />} />
    </span>
  );
}

/** Ordered people for display: the creator first when they have not posted, then active participants. */
export function participantPeople(
  data: { readonly participants: readonly string[]; readonly creator?: string | null } | null | undefined,
) {
  const names = data?.participants ?? [];
  const creator = data?.creator ?? null;
  return {
    creator,
    people: creator && !names.includes(creator) ? [creator, ...names] : [...names],
    others: names.filter((name) => name !== creator),
  };
}

/**
 * Title-row participants badge: the latest participant and a total, with a
 * popover listing the creator and everyone who posted. The Shell owns the slot
 * and popover exclusivity; mouse hover previews, click/tap/keyboard pin it.
 */
export function createThreadParticipantsBadge(id: string, source: ThreadParticipantsSource): ThreadBadgeContribution {
  function ThreadParticipantsBadge({
    hostId,
    threadId,
    open,
    onOpenChange,
    onCloseAutoFocus,
    portalContainer,
  }: ThreadBadgeProps) {
    const intl = useIntl();
    const snapshot = useSyncExternalStore(source.subscribe, () => source.getSnapshot(hostId, threadId));
    useEffect(() => source.watch(hostId, threadId), [hostId, threadId]);
    const hoverOpened = useRef(false);
    const hoverFocus = useRef(false);
    const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const cancelOpen = () => {
      clearTimeout(openTimer.current);
      openTimer.current = undefined;
    };
    const cancelClose = () => {
      clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
    };
    const unsupported = snapshot.phase === "unsupported";
    useEffect(() => {
      if (!open) hoverOpened.current = false;
      cancelOpen();
      cancelClose();
      return () => {
        cancelOpen();
        cancelClose();
      };
    }, [open, hostId, threadId, unsupported]);
    if (unsupported) return null;
    const leaveHover = () => {
      cancelOpen();
      cancelClose();
      if (hoverOpened.current) closeTimer.current = setTimeout(() => onOpenChange(false), HOVER_CLOSE_MS);
    };
    const { creator, people, others } = participantPeople(snapshot.data);
    const known = snapshot.data !== null;
    const latest = people.at(-1);
    const countLabel = intl.formatNumber(people.length);
    const showTotal = people.length > 1;
    const label = intl.formatMessage({
      id: "threadParticipants.view",
      defaultMessage: "View conversation participants",
    });
    return (
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          cancelOpen();
          cancelClose();
          hoverOpened.current = false;
          if (next) hoverFocus.current = false;
          onOpenChange(next);
        }}
      >
        <Popover.Trigger asChild>
          <DisclosureButton
            className="thread-participants__badge"
            aria-label={
              people.length
                ? intl.formatMessage(
                    {
                      id: "threadParticipants.viewCount",
                      defaultMessage: "View conversation participants ({count, number})",
                    },
                    { count: people.length },
                  )
                : label
            }
            onPointerEnter={(event) => {
              if (event.pointerType !== "mouse") return;
              cancelClose();
              cancelOpen();
              // Let the pointer cross the sidebar without opening a secondary surface.
              if (!open)
                openTimer.current = setTimeout(() => {
                  openTimer.current = undefined;
                  hoverOpened.current = true;
                  hoverFocus.current = true;
                  onOpenChange(true);
                }, HOVER_OPEN_MS);
            }}
            onPointerLeave={leaveHover}
            onPointerCancel={leaveHover}
            onPointerDown={cancelOpen}
            onKeyDown={cancelOpen}
            onWheel={cancelOpen}
            onClick={(event) => {
              cancelOpen();
              // A click pins an already visible hover preview for normal dismissal.
              if (hoverOpened.current) {
                hoverOpened.current = false;
                hoverFocus.current = false;
                cancelClose();
                event.preventDefault();
              }
            }}
          >
            <span className="thread-participants__stack">
              {latest ? (
                <ParticipantAvatar key={latest} name={latest} />
              ) : (
                <span className="thread-participants__avatar" aria-hidden="true">
                  <PersonIcon size={12} />
                </span>
              )}
            </span>
            {showTotal ? (
              <span className="thread-participants__total" aria-hidden="true">
                {countLabel}
              </span>
            ) : null}
          </DisclosureButton>
        </Popover.Trigger>
        <Popover.Portal container={portalContainer}>
          <Popover.Content
            className="thread-participants__popover"
            side="right"
            align="start"
            sideOffset={8}
            collisionPadding={12}
            aria-label={label}
            onPointerEnter={cancelClose}
            onPointerLeave={leaveHover}
            onOpenAutoFocus={(event) => {
              if (hoverOpened.current) event.preventDefault();
            }}
            onCloseAutoFocus={(event) => {
              if (hoverFocus.current) event.preventDefault();
              onCloseAutoFocus?.(event);
            }}
          >
            {creator ? (
              <section className="thread-participants__creator-section">
                <div className="thread-participants__heading">
                  {intl.formatMessage({ id: "threadParticipants.creator", defaultMessage: "Creator" })}
                </div>
                <div className="thread-participants__person">
                  <ParticipantAvatar name={creator} />
                  <span>{creator}</span>
                </div>
              </section>
            ) : null}
            <div className="thread-participants__heading">
              {intl.formatMessage({ id: "threadParticipants.heading", defaultMessage: "Participants" })}
            </div>
            {snapshot.phase === "error" ? (
              <div className="thread-participants__notice" role="status">
                {intl.formatMessage({ id: "threadParticipants.error", defaultMessage: "Couldn't update participants" })}
                {source.refresh ? (
                  <>
                    {" "}
                    <InlineAction onClick={() => source.refresh?.(hostId, threadId)}>
                      {intl.formatMessage({ id: "threadParticipants.retry", defaultMessage: "Retry" })}
                    </InlineAction>
                  </>
                ) : null}
              </div>
            ) : null}
            {!known && snapshot.phase === "loading" ? (
              <p role="status">
                {intl.formatMessage({ id: "threadParticipants.loading", defaultMessage: "Loading…" })}
              </p>
            ) : null}
            {known && others.length === 0 ? (
              <p>
                {intl.formatMessage({
                  id: "threadParticipants.empty",
                  defaultMessage: "No identified participants yet",
                })}
              </p>
            ) : null}
            {others.length > 0 ? (
              <ul>
                {others.map((name) => (
                  <li key={name} className="thread-participants__person">
                    <ParticipantAvatar name={name} />
                    <span>{name}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }
  return { id, placement: "title", Component: ThreadParticipantsBadge };
}
