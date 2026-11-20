import { CopyIcon as Copy, ExternalLinkIcon as ExternalLink, GlobeIcon as Globe2 } from "@opencraft/design-system-web/action-icons";
import { useSettledResourceTarget, chatWebLinkLabel, type ChatNodeRendererProps } from "@opencraft/chat-render-react";
import type { ChatResourceDecision, ChatResourceOpenIntent } from "@opencraft/chat-render-react";
import { FormattedMessage } from "@opencraft/i18n/react";
import * as ContextMenu from "@opencraft/design-system-web/context-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useMemo, useState, type MouseEvent } from "react";
import { writeTextToClipboard } from "../../clipboard";
import { externalLinkMenuIntent, externalLinkPointerIntent, faviconSources } from "./external-link-model";
function ExternalLinkGlyph({ target }: { readonly target: string | null }) {
  const sources = useMemo(() => target === null ? [] : faviconSources(target), [target]);
  // This keyed link instance owns availability and the sole visible glyph.
  // Keep the first successful candidate stable while other requests settle.
  const [readySources, setReadySources] = useState<readonly string[]>([]);
  const loaded = readySources[0] ?? null;
  return (
    <span aria-hidden="true" className="chat-external-link__icon" data-markdown-copy="exclude">
      {loaded === null ? <span className="chat-external-link__icon-fallback"><Globe2 /></span> : null}
      {sources.map((source) => (
        <img
          alt=""
          className={loaded === source ? "is-loaded" : undefined}
          decoding="async"
          key={source}
          onLoad={() => setReadySources((current) => current.includes(source) ? current : [...current, source])}
          onError={() => setReadySources((current) => current.filter((ready) => ready !== source))}
          referrerPolicy="no-referrer"
          src={source}
        />
      ))}
    </span>
  );
}

export function ExternalUrlLink({
  context,
  decision,
  label,
  title,
}: {
  readonly context: ChatNodeRendererProps["context"];
  readonly decision: ChatResourceDecision;
  readonly label: ReturnType<ChatNodeRendererProps["renderNodes"]>;
  readonly title: string | null;
}) {
  const target = useSettledResourceTarget(decision.allowed ? decision.target : null, context.streaming);
  const pending = decision.allowed && decision.target !== null && target === null;
  const invoke = (intent: ChatResourceOpenIntent) => {
    if (target === null) return;
    if (context.openResource !== undefined) context.openResource(target, decision, intent);
    else window.open(target, "_blank", "noopener,noreferrer");
  };
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (target === null || context.openResource !== undefined) event.preventDefault();
    if (target === null || context.openResource === undefined) return;
    const intent = externalLinkPointerIntent(event);
    if (intent !== null) invoke(intent);
  };
  const handleAuxClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 1) return;
    if (target === null || context.openResource !== undefined) event.preventDefault();
    const intent = externalLinkPointerIntent(event);
    if (target !== null && context.openResource !== undefined && intent !== null) invoke(intent);
  };
  const anchor = (
    <a
      aria-busy={pending || undefined}
      aria-disabled={target === null || undefined}
      className="chat-external-link"
      data-chat-resource-kind="external"
      data-markdown-raw-link-label={title ?? ""}
      href={target ?? undefined}
      onAuxClick={handleAuxClick}
      onClick={handleClick}
      rel="noopener noreferrer"
      target={context.openResource === undefined ? "_blank" : undefined}
    >
      <ExternalLinkGlyph key={target} target={target} />
      <span className="chat-external-link__label">{target !== null && title !== null && chatWebLinkLabel(target, title) !== title
        ? chatWebLinkLabel(target, title) : label}</span>
    </a>
  );
  return (
    <Tooltip.Provider delayDuration={450}>
      <ContextMenu.Root>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <ContextMenu.Trigger asChild>{anchor}</ContextMenu.Trigger>
          </Tooltip.Trigger>
          {target === null ? null : (
            <Tooltip.Portal>
              <Tooltip.Content className="chat-external-link-tooltip" sideOffset={5}>
                {target}<Tooltip.Arrow className="chat-external-link-tooltip__arrow" />
              </Tooltip.Content>
            </Tooltip.Portal>
          )}
        </Tooltip.Root>
        {target === null ? null : (
          <ContextMenu.Portal>
            <ContextMenu.Content className="chat-external-link-menu">
              <ContextMenu.Item onSelect={() => invoke(externalLinkMenuIntent("in-app-browser"))}>
                <Globe2 aria-hidden="true" /><FormattedMessage id="chat.link.openInBrowser" defaultMessage="Open in browser" />
              </ContextMenu.Item>
              <ContextMenu.Item onSelect={() => invoke(externalLinkMenuIntent("external-browser"))}>
                <ExternalLink aria-hidden="true" /><FormattedMessage id="chat.link.openExternal" defaultMessage="Open in external browser" />
              </ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onSelect={() => void writeTextToClipboard(target)}>
                <Copy aria-hidden="true" /><FormattedMessage id="chat.link.copy" defaultMessage="Copy link" />
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        )}
      </ContextMenu.Root>
    </Tooltip.Provider>
  );
}
