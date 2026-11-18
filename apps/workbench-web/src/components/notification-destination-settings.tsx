import { useEffect, useState, useSyncExternalStore } from "react";
import * as Menu from "@opencraft/design-system-web/dropdown-menu";
import { useIntl } from "@opencraft/i18n/react";
import {
  SettingsGroup,
  SettingsRow,
  SettingsSwitch,
  SettingsButton,
  SettingsTextInput,
  SettingsChoiceSelect,
  SettingsPanel,
} from "@opencraft/extension-react";
import type { TurnNotificationController, TurnNotificationSnapshot } from "../runtime/turn-notification-controller";
import {
  NotificationOperationError,
  type NotificationDestination,
  type NotificationConfiguration,
} from "../runtime/notification-destinations";
import { ModalSurface } from "./modal/modal-surface";
import { AdaptiveSheetHandle } from "./modal/adaptive-sheet-handle";
import { useAsyncNotices } from "./async-notices";
import "./notification-destination-settings.scss";

export function NotificationDestinationSettings({
  controller,
  local,
  localDescription,
  onOpenImSettings,
}: {
  onOpenImSettings?: () => void;
  controller: TurnNotificationController;
  local: TurnNotificationSnapshot;
  localDescription: string;
}) {
  const intl = useIntl(),
    notices = useAsyncNotices(),
    owner = controller.destinations;
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  const [menu, setMenu] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    kind: "bark" | "webhook" | "im";
    creationId: string;
    existing?: NotificationDestination;
  } | null>(null);
  const [url, setUrl] = useState(""),
    [authorization, setAuthorization] = useState(""),
    [target, setTarget] = useState("");
  const [formElement, setFormElement] = useState<HTMLDivElement | null>(null);
  const [advanced, setAdvanced] = useState(false),
    [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const config = state.configuration;
  useEffect(() => {
    setDraft(null);
    setUrl("");
    setAuthorization("");
    setMenu(null);
  }, [config?.actorId]);
  const t = {
    title: intl.formatMessage({ id: "settings.notifications.title", defaultMessage: "Notify when a response ends" }),
    description: intl.formatMessage({
      id: "settings.notifications.description",
      defaultMessage: "Notify me when a response completes, fails or stops on this server.",
    }),
    local: intl.formatMessage({ id: "settings.notifications.local", defaultMessage: "This device" }),
    add: intl.formatMessage({ id: "settings.notifications.add", defaultMessage: "Add notification method" }),
    bark: intl.formatMessage({ id: "settings.notifications.bark", defaultMessage: "Bark" }),
    webhook: intl.formatMessage({ id: "settings.notifications.webhook", defaultMessage: "Webhook" }),
    connectIm: intl.formatMessage({ id: "settings.notifications.connectIm", defaultMessage: "Open IM settings" }),
    im: intl.formatMessage({ id: "settings.notifications.im", defaultMessage: "Connected IM accounts" }),
    edit: intl.formatMessage({ id: "settings.notifications.edit", defaultMessage: "Edit" }),
    remove: intl.formatMessage({ id: "settings.notifications.remove", defaultMessage: "Remove" }),
    test: intl.formatMessage({ id: "settings.notifications.test", defaultMessage: "Send test notification" }),
    more: intl.formatMessage({ id: "settings.notifications.more", defaultMessage: "Notification actions" }),
    close: intl.formatMessage({ id: "common.close", defaultMessage: "Close" }),
    cancel: intl.formatMessage({ id: "settings.notifications.cancel", defaultMessage: "Cancel" }),
    save: intl.formatMessage({ id: "settings.notifications.save", defaultMessage: "Save and test" }),
    address: intl.formatMessage({ id: "settings.notifications.address", defaultMessage: "Push address" }),
    paste: intl.formatMessage({
      id: "settings.notifications.paste",
      defaultMessage: "Paste the link copied from Bark",
    }),
    webhookPaste: intl.formatMessage({
      id: "settings.notifications.webhookPaste",
      defaultMessage: "Enter the HTTPS receiver URL",
    }),
    curl: intl.formatMessage({
      id: "settings.notifications.curl",
      defaultMessage: "You can also paste a curl example.",
    }),
    replace: intl.formatMessage({
      id: "settings.notifications.replace",
      defaultMessage: "Leave blank to keep the saved address.",
    }),
    advanced: intl.formatMessage({ id: "settings.notifications.advanced", defaultMessage: "Advanced settings" }),
    auth: intl.formatMessage({
      id: "settings.notifications.authorization",
      defaultMessage: "Authorization header (optional)",
    }),
    receiver: intl.formatMessage({ id: "settings.notifications.receiver", defaultMessage: "Send to" }),
    choose: intl.formatMessage({ id: "settings.notifications.choose", defaultMessage: "Select your IM account" }),
    noIm: intl.formatMessage({
      id: "settings.notifications.noIm",
      defaultMessage:
        "No linked IM account is available. Connect an IM account and link your identity in IM settings first.",
    }),
    saved: intl.formatMessage({
      id: "settings.notifications.sent",
      defaultMessage: "Submitted to the notification service. Check your receiving device.",
    }),
    reconnect: intl.formatMessage({
      id: "settings.notifications.reconnect",
      defaultMessage: "Open Edit and save to reconnect this notification method.",
    }),
    webhookHint: intl.formatMessage({
      id: "settings.notifications.webhookHint",
      defaultMessage: "Sends a POST with the result, conversation title and link. Full responses are not included.",
    }),
    linkHint: intl.formatMessage({
      id: "settings.notifications.linkHint",
      defaultMessage: "Tap the notification to return to the conversation.",
    }),
  };
  const failureMessages = {
    address: intl.formatMessage({
      id: "settings.notifications.error.address",
      defaultMessage: "Invalid address. Paste the complete HTTPS push URL. Bark also accepts a GET curl example.",
    }),
    account: intl.formatMessage({
      id: "settings.notifications.error.account",
      defaultMessage: "Your session expired or the account changed. Sign in again and retry.",
    }),
    forbidden: intl.formatMessage({
      id: "settings.notifications.error.forbidden",
      defaultMessage: "The server rejected this request. Reopen settings from the signed-in website and retry.",
    }),
    unavailable: intl.formatMessage({
      id: "settings.notifications.error.unavailable",
      defaultMessage:
        "The notification API is unavailable. Refresh the page; if this continues, ask the administrator to check the server version.",
    }),
    storage: intl.formatMessage({
      id: "settings.notifications.error.storage",
      defaultMessage:
        "The server cannot save notification settings right now. Retry later; if this continues, contact the administrator.",
    }),
    limit: intl.formatMessage({
      id: "settings.notifications.error.limit",
      defaultMessage:
        "You reached the limit of 16 notification methods, including device push subscriptions. Remove an unused method first.",
    }),
    missing: intl.formatMessage({
      id: "settings.notifications.error.missing",
      defaultMessage: "This notification method no longer exists. Refresh the list and add it again.",
    }),
    im: intl.formatMessage({
      id: "settings.notifications.error.im",
      defaultMessage:
        "The selected IM account is unavailable or unlinked. Link it again in IM settings, then select it.",
    }),
    rate: intl.formatMessage({
      id: "settings.notifications.error.rate",
      defaultMessage: "Too many test requests. Wait 30 seconds and retry.",
    }),
    delivery: intl.formatMessage({
      id: "settings.notifications.error.delivery",
      defaultMessage:
        "The test delivery could not be completed. Check the push address or receiving service, then retry from the notification menu.",
    }),
    network: intl.formatMessage({
      id: "settings.notifications.error.network",
      defaultMessage:
        "The connection was lost; the result is unconfirmed. Reconnect and check the notification list before retrying.",
    }),
    timeout: intl.formatMessage({
      id: "settings.notifications.error.timeout",
      defaultMessage: "The request timed out; the result is unconfirmed. Check the notification list before retrying.",
    }),
    unknown: intl.formatMessage({
      id: "settings.notifications.error.unknown",
      defaultMessage:
        "The operation did not succeed; no specific reason is available. Retry later; if this continues, contact the administrator.",
    }),
  };
  const failureMessage = (error: unknown) =>
    failureMessages[error instanceof NotificationOperationError ? error.reason : "unknown"];
  if (!config) return null;
  const error = (cause: unknown) => notices.error({ key: "notification-destinations", message: failureMessage(cause) });
  const operation = (name: string, fields: Record<string, unknown>) => {
    void owner
      .operation(name, fields)
      .then(() => {
        if (name === "test") notices.info({ key: "notification-test", message: t.saved });
      })
      .catch(error);
  };
  const open = (kind: "bark" | "webhook" | "im", existing?: NotificationDestination) => {
    setMenu(null);
    setUrl("");
    setAuthorization("");
    setAdvanced(false);
    setFormError(null);
    setTarget(existing?.kind === "im" ? JSON.stringify([existing.channelId, existing.senderId]) : "");
    setDraft({ kind, existing, creationId: crypto.randomUUID() });
  };
  const name = (kind: "bark" | "webhook" | "im") => t[kind];
  const popup = (id: string, children: React.ReactNode, trigger: string, label = trigger) => (
    <Menu.Root open={menu === id} onOpenChange={(value) => setMenu(value ? id : null)}>
      <Menu.Trigger asChild>
        <SettingsButton variant="quiet" disabled={!!state.busy || saving} aria-label={label}>
          {trigger}
        </SettingsButton>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="notification-destinations__menu" sideOffset={6} collisionPadding={12} align="end">
          {children}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
  const item = (label: string, action: () => void) => (
    <Menu.Item className="notification-destinations__menu-item" onSelect={action}>
      {label}
    </Menu.Item>
  );
  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setFormError(null);
    let saved = false;
    try {
      const selected = config.imTargets.find((value) => JSON.stringify([value.channelId, value.senderId]) === target);
      const response = (await owner.operation("save", {
        id: draft.existing?.id,
        creationId: draft.creationId,
        target:
          draft.kind === "im"
            ? { kind: "im", channelId: selected?.channelId, senderId: selected?.senderId }
            : {
                kind: draft.kind,
                url: url.trim(),
                ...(draft.kind === "webhook" ? { authorization: authorization.trim() } : {}),
              },
      })) as NotificationConfiguration;
      saved = true;
      setDraft(null);
      setUrl("");
      setAuthorization("");
      await owner.operation("test", { id: response.savedId });
      notices.info({ key: "notification-test", message: t.saved });
    } catch (cause) {
      const reason = failureMessage(cause);
      if (!saved && owner.getSnapshot().configuration?.actorId === config.actorId) setFormError(reason);
      else
        notices.error({
          key: "notification-destinations",
          message: saved
            ? intl.formatMessage(
                { id: "settings.notifications.savedWithReason", defaultMessage: "Settings saved. {reason}" },
                { reason },
              )
            : reason,
        });
    } finally {
      setSaving(false);
    }
  };
  const dialogTitle = draft
    ? intl.formatMessage(
        { id: "settings.notifications.dialogTitle", defaultMessage: "{action} · {method}" },
        { action: draft.existing ? t.edit : t.add, method: name(draft.kind) },
      )
    : "";
  return (
    <section className="notification-destinations" aria-label={t.title}>
      <SettingsGroup>
        <SettingsRow label={t.title} description={t.description} controlWidth="compact">
          <SettingsSwitch
            label={t.title}
            checked={config.enabled}
            disabled={!!state.busy}
            onCheckedChange={(enabled) => operation("master", { enabled })}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow label={t.local} description={localDescription} controlWidth="compact">
          <div className="notification-destinations__actions">
            <SettingsSwitch
              label={t.local}
              checked={local.enabled}
              disabled={!config.enabled || !local.supported || local.busy}
              onCheckedChange={(enabled) => {
                void controller.setEnabled(enabled);
              }}
            />
            {local.enabled && local.delivery === "background"
              ? popup(
                  "local",
                  item(t.test, () => {
                    void controller.test();
                  }),
                  "…",
                  t.more,
                )
              : null}
          </div>
        </SettingsRow>
        {config.destinations.map((destination) => (
          <SettingsRow
            key={destination.id}
            label={name(destination.kind)}
            description={destination.authorized ? destination.label : t.reconnect}
            controlWidth="compact"
          >
            <div className="notification-destinations__actions">
              <SettingsSwitch
                label={intl.formatMessage(
                  { id: "settings.notifications.toggle", defaultMessage: "Enable {method}" },
                  { method: name(destination.kind) },
                )}
                checked={destination.enabled}
                disabled={!config.enabled || !!state.busy}
                onCheckedChange={(enabled) => operation("enable", { id: destination.id, enabled })}
              />
              {popup(
                destination.id,
                <>
                  {item(t.test, () => operation("test", { id: destination.id }))}
                  {item(t.edit, () => open(destination.kind, destination))}
                  {item(t.remove, () => operation("remove", { id: destination.id }))}
                </>,
                "…",
                t.more,
              )}
            </div>
          </SettingsRow>
        ))}
        <SettingsRow label={t.add} controlWidth="compact">
          {popup(
            "add",
            <>
              {item(t.bark, () => open("bark"))}
              {item(t.webhook, () => open("webhook"))}
              {item(t.im, () => open("im"))}
            </>,
            "+",
            t.add,
          )}
        </SettingsRow>
      </SettingsGroup>
      {draft ? (
        <ModalSurface
          label={dialogTitle}
          closeLabel={t.close}
          appearance="utility"
          size="compact"
          presentation="adaptive-sheet"
          initialFocus="surface"
          dismissOnOutsidePress={!saving}
          showCloseButton={!saving}
          onDismiss={() => {
            if (!saving) {
              setDraft(null);
              setUrl("");
              setAuthorization("");
            }
          }}
        >
          <AdaptiveSheetHandle
            onDismiss={() => {
              if (!saving) setDraft(null);
            }}
          />
          <SettingsPanel
            title={dialogTitle}
            footer={
              <>
                <SettingsButton disabled={saving} onClick={() => setDraft(null)}>
                  {t.cancel}
                </SettingsButton>
                <SettingsButton
                  variant="primary"
                  loading={saving}
                  disabled={saving || !!state.busy || (draft.kind === "im" ? !target : !url.trim() && !draft.existing)}
                  onClick={() => {
                    void save();
                  }}
                >
                  {t.save}
                </SettingsButton>
              </>
            }
          >
            <div className="notification-destinations__form" ref={setFormElement}>
              {formError ? (
                <p role="alert" className="notification-destinations__error">
                  {formError}
                </p>
              ) : null}
              {draft.kind === "im" ? (
                <>
                  <SettingsRow
                    layout="stacked"
                    label={t.receiver}
                    description={!config.imTargets.length ? t.noIm : undefined}
                  >
                    <SettingsChoiceSelect
                      portalContainer={formElement}
                      label={t.receiver}
                      value={target}
                      onValueChange={setTarget}
                      placeholder={t.choose}
                      options={config.imTargets.map((value) => ({
                        value: JSON.stringify([value.channelId, value.senderId]),
                        label: value.label,
                      }))}
                      disabled={saving || !config.imTargets.length}
                    />
                  </SettingsRow>
                  {onOpenImSettings ? (
                    <SettingsButton
                      variant="quiet"
                      disabled={saving}
                      onClick={() => {
                        setDraft(null);
                        onOpenImSettings();
                      }}
                    >
                      {t.connectIm}
                    </SettingsButton>
                  ) : null}
                </>
              ) : (
                <>
                  <SettingsRow
                    layout="stacked"
                    label={t.address}
                    htmlFor="notification-address"
                    description={draft.existing ? t.replace : draft.kind === "bark" ? t.curl : t.webhookHint}
                  >
                    <SettingsTextInput
                      id="notification-address"
                      value={url}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={draft.kind === "bark" ? t.paste : t.webhookPaste}
                      onChange={(event) => setUrl(event.currentTarget.value)}
                      disabled={saving}
                    />
                  </SettingsRow>
                  {draft.kind === "webhook" ? (
                    <>
                      <SettingsButton variant="quiet" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
                        {t.advanced}
                      </SettingsButton>
                      {advanced ? (
                        <SettingsRow layout="stacked" label={t.auth} htmlFor="notification-authorization">
                          <SettingsTextInput
                            id="notification-authorization"
                            type="password"
                            autoComplete="new-password"
                            value={authorization}
                            disabled={saving}
                            onChange={(event) => setAuthorization(event.currentTarget.value)}
                          />
                        </SettingsRow>
                      ) : null}
                    </>
                  ) : (
                    <p className="notification-destinations__hint">{t.linkHint}</p>
                  )}
                </>
              )}
            </div>
          </SettingsPanel>
        </ModalSurface>
      ) : null}
    </section>
  );
}
