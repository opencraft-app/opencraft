import { useSyncExternalStore } from "react";
import type { ChannelRuntime } from "./channel-runtime";
import type { PersonalAssistantStatus, PersonalAssistantRuntimeState } from "@opencraft/appserver-protocol";
import { useIntl } from "@opencraft/i18n/react";
import { CompanionAvatar } from "@opencraft/design-system-web/companion-avatar";
import type { CompanionActivity } from "@opencraft/design-system/companion-motion";

const labels = {
  capacity: { id: "im.assistant.capacity", defaultMessage: "Waiting for model capacity…" },
  rateLimit: { id: "im.assistant.rateLimit", defaultMessage: "Model service busy; waiting to retry…" },
  processing: { id: "im.assistant.processing", defaultMessage: "Replying…" },
  queue: { id: "im.assistant.queue", defaultMessage: "Replying… {count} waiting" },
  waiting: { id: "im.assistant.waiting", defaultMessage: "Waiting for a reply…" },
  starting: { id: "im.assistant.starting", defaultMessage: "Assistant starting…" },
  unavailable: { id: "im.assistant.unavailable", defaultMessage: "Assistant status unavailable" },
  model: { id: "im.assistant.model", defaultMessage: "Choose an assistant model in Agents" },
};

/** One observation owner per open DM. A stale observation loses work/presence immediately. */
export function useAssistantObservation(runtime: ChannelRuntime, channelId: string | null) {
  const state = useSyncExternalStore(runtime.assistant.subscribe, runtime.assistant.get, runtime.assistant.get);
  return state.authoritative && state.value?.channelId === channelId ? state.value : null;
}

export function AssistantActivity({
  runtime,
  avatarId,
}: {
  runtime: PersonalAssistantRuntimeState | null;
  avatarId: string;
}) {
  const intl = useIntl();
  let text = "";
  if (runtime?.phase === "running") {
    const activity = runtime.reception;
    if (!activity) text = intl.formatMessage(labels.unavailable);
    else if (activity.running && runtime.modelWait)
      text = intl.formatMessage(runtime.modelWait.reason === "rate_limit" ? labels.rateLimit : labels.capacity);
    else if (activity.running)
      text = intl.formatMessage(activity.queued ? labels.queue : labels.processing, { count: activity.queued });
    else if (activity.queued) text = intl.formatMessage(labels.waiting);
  } else if (runtime)
    text = intl.formatMessage(
      runtime.phase === "config_required"
        ? labels.model
        : ["starting", "queued", "retrying"].includes(runtime.phase)
          ? labels.starting
          : labels.unavailable,
    );
  const busy = !!text && runtime && ["running", "starting", "queued", "retrying"].includes(runtime.phase);
  return (
    <div role="status" aria-live="polite" className="im-assistant-activity" data-active={!!text}>
      {busy ? <CompanionAvatar id={avatarId} size={28} activity={assistantVisualActivity(runtime)} /> : null}
      {text && <span>{text}</span>}
    </div>
  );
}

/** Domain runtime owns truth; artwork only receives the presentation activity. */
export function assistantVisualActivity(runtime: PersonalAssistantRuntimeState | null): CompanionActivity {
  if (runtime?.phase === "running" && runtime.reception?.running) return runtime.modelWait ? "waiting" : "working";
  if (
    (runtime?.phase === "running" && runtime.reception?.queued) ||
    (runtime && ["starting", "queued", "retrying"].includes(runtime.phase))
  )
    return "waiting";
  return "rest";
}
