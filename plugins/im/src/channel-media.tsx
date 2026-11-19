import { useEffect, useRef, useState } from "react";
import { MediaPlayer } from "@opencraft/file-preview-web/media-player";
import { Button } from "@opencraft/design-system-web/button";
import { useIntl } from "@opencraft/i18n/react";
import { useChannelResource, type ChannelResources, type ChannelResourceTarget } from "./channel-resources";

export { channelMediaKind } from "./channel-media-kind";
function playable(blob: Blob, kind: "audio" | "video", name: string): boolean {
  const mime =
    blob.type && blob.type !== "application/octet-stream"
      ? blob.type
      : (
          {
            mp3: "audio/mpeg",
            wav: "audio/wav",
            ogg: "audio/ogg",
            m4a: "audio/mp4",
            aac: "audio/aac",
            flac: "audio/flac",
            opus: "audio/ogg; codecs=opus",
            mp4: "video/mp4",
            webm: "video/webm",
            mov: "video/quicktime",
          } as Record<string, string>
        )[name.split(".").at(-1)?.toLowerCase() ?? ""];
  return !!mime && typeof document !== "undefined" && document.createElement(kind).canPlayType(mime) !== "";
}
export function ChannelMedia({
  resources,
  target,
  name,
  kind,
  active = true,
}: {
  resources: ChannelResources;
  target: ChannelResourceTarget;
  name: string;
  kind: "audio" | "video";
  active?: boolean;
}) {
  const intl = useIntl(),
    [requested, setRequested] = useState(false),
    [failed, setFailed] = useState(false),
    retry = useRef(false);
  const snapshot = useChannelResource(resources, target, requested && active);
  useEffect(() => {
    if (!active) setRequested(false);
  }, [active]);
  const blob = snapshot.value?.blob,
    ready = blob && playable(blob, kind, name);
  const unavailable = failed || snapshot.status === "unavailable" || (!!blob && !ready);
  async function load() {
    if (retry.current) return;
    retry.current = true;
    try {
      await resources.retry(target);
      setFailed(false);
      setRequested(true);
    } finally {
      retry.current = false;
    }
  }
  return (
    <div className="im-channel-media">
      {!requested ? (
        <Button variant="secondary" onClick={() => setRequested(true)}>
          {intl.formatMessage({ id: "im.media.play", defaultMessage: "Load media" })}
        </Button>
      ) : unavailable ? (
        <>
          <small role="status">
            {intl.formatMessage({
              id: "media.unavailable",
              defaultMessage: "Preview unavailable. Download this file to open it.",
            })}
          </small>
          <Button variant="ghost" onClick={() => void load().catch(() => setFailed(true))}>
            {intl.formatMessage({ id: "common.retry", defaultMessage: "Try again" })}
          </Button>
        </>
      ) : ready ? (
        <MediaPlayer blob={blob} kind={kind} label={name} active={active} onError={() => setFailed(true)} />
      ) : (
        <small role="status">{intl.formatMessage({ id: "im.media.loading", defaultMessage: "Loading media…" })}</small>
      )}
    </div>
  );
}
