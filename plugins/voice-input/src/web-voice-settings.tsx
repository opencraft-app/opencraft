import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useIntl } from "@opencraft/i18n/react";
import { isTouchPresentation, subscribeTouchPresentation } from "@opencraft/design-system-web/input-presentation";
import { SettingsButton, SettingsChoiceSelect, SettingsGroup, SettingsNotice, SettingsPageHeader, SettingsRow, SettingsSection } from "@opencraft/extension-react";
import type { SpeechServiceClient, VoiceInputPreference, VoiceProviderChoice } from "./cloud-speech";

class ValdiMountBoundary extends Component<{ readonly fallback: ReactNode; readonly children: ReactNode }, { readonly failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

const LazyValdiVoiceInputSettings = lazy(async () => {
  const mod = await import("@opencraft/design-system-web/valdi");
  function VoiceInputSettingsMount({
    viewModel,
  }: {
    readonly viewModel: import("@opencraft/design-system-web/valdi").VoiceInputSettingsProps;
  }) {
    return (
      <mod.ValdiSurface
        component={mod.VoiceInputSettingsSurface}
        viewModel={viewModel}
        className="valdi-voice-input-settings-surface"
        data-testid="valdi-voice-input-settings-surface"
      />
    );
  }
  return { default: VoiceInputSettingsMount };
});

function useResolvedDark(): boolean {
  const read = () => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
  const subscribe = useCallback((listener: () => void) => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
    const observer = new MutationObserver(listener);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return useSyncExternalStore(subscribe, read, () => false);
}

export function createWebVoiceSettings(service: SpeechServiceClient, usePreferences: () => VoiceInputPreference) {
  return function WebVoiceSettings() {
    const intl = useIntl();
    const preferences = usePreferences();
    const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
    const dark = useResolvedDark();
    const subscribeTouch = useCallback(
      (onChange: () => void) =>
        typeof document === "undefined" || typeof MutationObserver === "undefined"
          ? () => {}
          : subscribeTouchPresentation(document, onChange),
      [],
    );
    const readTouch = useCallback(() => (typeof document === "undefined" ? false : isTouchPresentation(document)), []);
    const touch = useSyncExternalStore(subscribeTouch, readTouch, () => false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(false);
    const alive = useRef(true);
    useEffect(() => {
      alive.current = true;
      void service.refresh();
      return () => {
        alive.current = false;
      };
    }, []);

    const selected = snapshot.selection ? JSON.stringify([snapshot.selection.providerId, snapshot.selection.modelId]) : "";
    const known = snapshot.models.some((model) => JSON.stringify([model.providerId, model.modelId]) === selected);
    const title = intl.formatMessage({ id: "settings.contributions.voiceInput", defaultMessage: "Voice input" });
    const subtitle = intl.formatMessage({
      id: "settings.voice.web.description",
      defaultMessage: "Stop recording to insert text, or send it after recognition.",
    });
    const methodTitle = intl.formatMessage({ id: "settings.voice.web.method", defaultMessage: "Recognition method" });
    const modelTitle = intl.formatMessage({ id: "settings.voice.web.model", defaultMessage: "Transcription model" });
    const hunyuanStatus = snapshot.phase === "ready"
      ? intl.formatMessage({ id: "settings.voice.web.status.available", defaultMessage: "Available" })
      : snapshot.phase === "loading"
        ? intl.formatMessage({ id: "settings.voice.web.status.checking", defaultMessage: "Checking…" })
        : intl.formatMessage({ id: "settings.voice.web.status.unavailable", defaultMessage: "Unavailable" });

    const methodOptions = useMemo(
      () => [
        { id: "auto", title: intl.formatMessage({ id: "settings.voice.web.provider.auto", defaultMessage: "Automatic" }) },
        { id: "hunyuan", title: intl.formatMessage({ id: "settings.voice.web.provider.hunyuan", defaultMessage: "Hunyuan Speech" }) },
        { id: "system", title: intl.formatMessage({ id: "settings.voice.web.provider.browser", defaultMessage: "Browser speech" }) },
      ],
      [intl],
    );

    const modelOptions = useMemo(
      () => [
        { id: "", title: intl.formatMessage({ id: "settings.voice.web.model.none", defaultMessage: "Not selected" }) },
        ...(selected && !known
          ? [{ id: selected, disabled: true, title: intl.formatMessage({ id: "settings.voice.web.model.unavailable", defaultMessage: "Selected model is no longer available" }) }]
          : []),
        ...snapshot.models.map((model) => ({
          id: JSON.stringify([model.providerId, model.modelId]),
          disabled: !model.enabled,
          title: model.name + (model.enabled ? "" : intl.formatMessage({ id: "settings.voice.web.model.disabled", defaultMessage: " (not enabled)" })),
        })),
      ],
      [intl, known, selected, snapshot.models],
    );

    const handleRefresh = useCallback(() => {
      void service.refresh();
    }, []);

    const handleChangeMethod = useCallback(
      (value: string) => {
        setError(false);
        setSaving(true);
        void preferences
          .setProvider(value as VoiceProviderChoice)
          .catch(() => {
            if (alive.current) setError(true);
          })
          .finally(() => {
            if (alive.current) setSaving(false);
          });
      },
      [preferences],
    );

    const handleChangeModel = useCallback(
      (value: string) => {
        const ids: string[] | null = value ? JSON.parse(value) : null;
        setError(false);
        setSaving(true);
        void service
          .selectModel(ids ? { providerId: ids[0]!, modelId: ids[1]! } : null)
          .catch(() => {
            if (alive.current) setError(true);
          })
          .finally(() => {
            if (alive.current) setSaving(false);
          });
      },
      [],
    );

    const viewModel = useMemo(
      (): import("@opencraft/design-system-web/valdi").VoiceInputSettingsProps => ({
        dark,
        touch,
        title,
        subtitle,
        serviceGroupTitle: intl.formatMessage({ id: "settings.voice.web.service", defaultMessage: "Recognition service" }),
        refreshLabel: intl.formatMessage({ id: "settings.voice.web.refresh", defaultMessage: "Refresh" }),
        refreshing: snapshot.phase === "loading",
        saving,
        methodTitle,
        methodDescription: intl.formatMessage({
          id: "settings.voice.web.methodDescription",
          defaultMessage: "This choice applies only to the next dictation and does not change the chat model.",
        }),
        methodValue: preferences.provider,
        methodOptions,
        modelTitle,
        modelDescription: intl.formatMessage({
          id: "settings.voice.web.modelDescription",
          defaultMessage: "Add and enable a Hunyuan Speech connection in Model services. Credentials stay with Model services.",
        }),
        modelValue: selected,
        modelDisabled: snapshot.revision === null,
        modelOptions,
        hunyuanTitle: intl.formatMessage({ id: "settings.voice.web.provider.hunyuan", defaultMessage: "Hunyuan Speech" }),
        hunyuanDescription: intl.formatMessage({
          id: "settings.voice.web.hunyuanDescription",
          defaultMessage: "Recordings are used only for transcription. The service credential is managed by the server.",
        }),
        hunyuanStatus,
        hunyuanTone: snapshot.phase === "ready" ? "ready" : snapshot.phase === "loading" ? "loading" : "unavailable",
        durationTitle: intl.formatMessage({ id: "settings.voice.web.duration", defaultMessage: "Recording length" }),
        durationDescription: intl.formatMessage({
          id: "settings.voice.web.durationDescription",
          defaultMessage: "Up to two minutes at a time. Failed or cancelled recordings keep the existing input.",
        }),
        durationValue: intl.formatMessage({
          id: "settings.voice.web.durationValue",
          defaultMessage: "Recognition finishes after you stop",
        }),
        errorMessage: error
          ? intl.formatMessage({ id: "settings.voice.web.saveError", defaultMessage: "Could not save. Refresh and check again." })
          : undefined,
        onRefresh: handleRefresh,
        onChangeMethod: handleChangeMethod,
        onChangeModel: handleChangeModel,
      }),
      [
        dark, error, handleChangeMethod, handleChangeModel, handleRefresh, hunyuanStatus, intl, methodOptions, methodTitle,
        modelOptions, modelTitle, preferences.provider, saving, selected, snapshot.phase, snapshot.revision, subtitle, title, touch,
      ],
    );

    const fallback = (
      <>
        <SettingsPageHeader title={title} description={subtitle} />
        <SettingsSection
          title={viewModel.serviceGroupTitle}
          action={<SettingsButton disabled={viewModel.refreshing} onClick={handleRefresh}>{viewModel.refreshLabel}</SettingsButton>}
        >
          <SettingsGroup>
            <SettingsRow label={methodTitle} htmlFor="web-speech-provider" description={viewModel.methodDescription}>
              <SettingsChoiceSelect<VoiceProviderChoice>
                id="web-speech-provider"
                label={methodTitle}
                value={preferences.provider}
                disabled={saving}
                onValueChange={handleChangeMethod}
                options={methodOptions.map((o) => ({ value: o.id as VoiceProviderChoice, label: o.title }))}
              />
            </SettingsRow>
            <SettingsRow label={modelTitle} htmlFor="web-speech-model" description={viewModel.modelDescription}>
              <SettingsChoiceSelect
                id="web-speech-model"
                label={modelTitle}
                value={selected}
                disabled={saving || snapshot.revision === null}
                onValueChange={handleChangeModel}
                options={modelOptions.map((o) => ({ value: o.id, disabled: o.disabled, label: o.title }))}
              />
            </SettingsRow>
            <SettingsRow label={viewModel.hunyuanTitle} description={viewModel.hunyuanDescription}>{hunyuanStatus}</SettingsRow>
            <SettingsRow label={viewModel.durationTitle} description={viewModel.durationDescription}>{viewModel.durationValue}</SettingsRow>
          </SettingsGroup>
          {viewModel.errorMessage && <SettingsNotice tone="error">{viewModel.errorMessage}</SettingsNotice>}
        </SettingsSection>
      </>
    );

    return (
      <ValdiMountBoundary fallback={fallback}>
        <Suspense fallback={fallback}>
          <LazyValdiVoiceInputSettings viewModel={viewModel} />
        </Suspense>
      </ValdiMountBoundary>
    );
  };
}
