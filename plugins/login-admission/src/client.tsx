import { useEffect, useId, useRef, useState } from "react";
import type { TrustedExtensionDefinition } from "@opencraft/extension-runtime";
import {
  SettingsActions,
  SettingsButton,
  SettingsGroup,
  SettingsNotice,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  SettingsTextInput,
  type ExtensionSettingsViewProps,
} from "@opencraft/extension-react";
import { IconButton } from "@opencraft/design-system-web/button";
import { RefreshIcon } from "@opencraft/design-system-web/action-icons";
import { useIntl } from "@opencraft/i18n/react";
import { ADMIT_FUNCTION_EXAMPLE, type LoginAdmissionDocument, type LoginAdmissionMatch } from "./contract";
import {
  LoginAdmissionController,
  LoginAdmissionRequestError,
  draftFromRules,
  type LoginAdmissionDraft,
} from "./controller";
import "./login-admission.scss";

const ID = "opencraft.login-admission";

const messages = {
  title: { id: "loginAdmission.title", defaultMessage: "Sign-in admission" },
  description: {
    id: "loginAdmission.description",
    defaultMessage: "Choose which verified sign-ins can enter this server. Member grants and revocations still apply.",
  },
  loading: { id: "loginAdmission.loading", defaultMessage: "Loading…" },
  loadFailed: { id: "loginAdmission.loadFailed", defaultMessage: "Couldn't load the admission policy." },
  reload: { id: "loginAdmission.reload", defaultMessage: "Reload" },
  policy: { id: "loginAdmission.policy", defaultMessage: "Policy" },
  restrict: { id: "loginAdmission.restrict", defaultMessage: "Restrict sign-ins" },
  restrictDescription: {
    id: "loginAdmission.restrict.description",
    defaultMessage: "When off, every verified sign-in from {provider} is admitted as before.",
  },
  attribute: { id: "loginAdmission.attribute", defaultMessage: "Compared attribute" },
  attributeDescription: {
    id: "loginAdmission.attribute.description",
    defaultMessage: "Rules match this verified value from the sign-in provider.",
  },
  published: { id: "loginAdmission.published", defaultMessage: "Published version" },
  publishedValue: { id: "loginAdmission.published.value", defaultMessage: "Version {revision, number} · {date}" },
  neverPublished: { id: "loginAdmission.published.none", defaultMessage: "Not published yet" },
  rules: { id: "loginAdmission.rules", defaultMessage: "Rules" },
  rulesDescription: {
    id: "loginAdmission.rules.description",
    defaultMessage: "A sign-in is admitted when any rule matches it.",
  },
  allowlist: { id: "loginAdmission.allowlist", defaultMessage: "Allowed values" },
  allowlistDescription: {
    id: "loginAdmission.allowlist.description",
    defaultMessage: "One value per line. Letter case is ignored.",
  },
  patterns: { id: "loginAdmission.patterns", defaultMessage: "Patterns" },
  patternsDescription: {
    id: "loginAdmission.patterns.description",
    defaultMessage: "One per line. * matches any text and ? matches one character.",
  },
  conditions: { id: "loginAdmission.conditions", defaultMessage: "Attribute conditions" },
  conditionsDescription: {
    id: "loginAdmission.conditions.description",
    defaultMessage: "One per line as attribute=value, for other verified attributes.",
  },
  function: { id: "loginAdmission.function", defaultMessage: "Admission function" },
  functionDescription: {
    id: "loginAdmission.function.description",
    defaultMessage:
      "Optional. Define admit(input) and return '{ allow: true }' to admit. It runs isolated, without network or file access, for at most 100 ms. Errors refuse the sign-in.",
  },
  discard: { id: "loginAdmission.discard", defaultMessage: "Discard changes" },
  publish: { id: "loginAdmission.publish", defaultMessage: "Publish" },
  publishedResult: { id: "loginAdmission.publish.done", defaultMessage: "Policy published" },
  test: { id: "loginAdmission.test", defaultMessage: "Test a sign-in" },
  testDescription: {
    id: "loginAdmission.test.description",
    defaultMessage: "Checks the rules above, including unpublished changes. Nothing is saved.",
  },
  testValue: { id: "loginAdmission.test.value", defaultMessage: "Value of {attribute}" },
  runTest: { id: "loginAdmission.test.run", defaultMessage: "Run test" },
  admitted: {
    id: "loginAdmission.test.admitted",
    defaultMessage:
      "Admitted by {rule, select, allowlist {an allowed value} pattern {a pattern} condition {an attribute condition} other {the admission function}}",
  },
  refused: { id: "loginAdmission.test.refused", defaultMessage: "Refused" },
  refusedFailure: { id: "loginAdmission.test.failed", defaultMessage: "Refused because the admission function failed" },
  history: { id: "loginAdmission.history", defaultMessage: "Earlier versions" },
  version: { id: "loginAdmission.history.version", defaultMessage: "Version {revision, number}" },
  restore: { id: "loginAdmission.history.restore", defaultMessage: "Edit from this version" },
  errorConflict: {
    id: "loginAdmission.error.conflict",
    defaultMessage: "Another administrator published a newer policy. Discard your changes to load it.",
  },
  errorSelfLock: {
    id: "loginAdmission.error.selfLock",
    defaultMessage: "This policy would refuse your own sign-in. Include your account before publishing.",
  },
  errorInvalid: {
    id: "loginAdmission.error.invalid",
    defaultMessage: "Check the rules: a value, condition or the function is not valid.",
  },
  errorAdmin: {
    id: "loginAdmission.error.admin",
    defaultMessage: "Only server administrators can change sign-in admission.",
  },
  errorGeneric: { id: "loginAdmission.error.generic", defaultMessage: "Couldn't complete the request. Try again." },
};

const sameDraft = (a: LoginAdmissionDraft, b: LoginAdmissionDraft) => JSON.stringify(a) === JSON.stringify(b);

export function createLoginAdmissionView(controller: LoginAdmissionController) {
  return function LoginAdmissionView(props: ExtensionSettingsViewProps) {
    const intl = useIntl();
    const t = (message: { id: string; defaultMessage: string }, values?: Record<string, string | number>) =>
      intl.formatMessage(message, values);
    const ids = useId();
    const [document, setDocument] = useState<LoginAdmissionDocument | null>(null);
    const [draft, setDraftState] = useState<LoginAdmissionDraft | null>(controller.draft);
    const [pending, setPending] = useState<"load" | "publish" | "preview" | null>("load");
    const [loadFailed, setLoadFailed] = useState(false);
    const [publishResult, setPublishResult] = useState<string | null>(null);
    const [testValue, setTestValue] = useState("");
    const [testResult, setTestResult] = useState<string | null>(null);
    const lifetime = useRef(0),
      edits = useRef(0);
    /** The published document the editor last showed, read by asynchronous reloads. */
    const shown = useRef<LoginAdmissionDocument | null>(null);

    const setDraft = (next: LoginAdmissionDraft, revision?: number) => {
      controller.draft = next;
      if (revision !== undefined) controller.draftRevision = revision;
      edits.current++;
      setDraftState(next);
      setPublishResult(null);
      setTestResult(null);
    };
    const report = (error: unknown) => {
      const code = error instanceof LoginAdmissionRequestError ? error.code : "request_failed";
      const message =
        code === "revision_conflict"
          ? messages.errorConflict
          : code === "cannot_remove_own_administration"
            ? messages.errorSelfLock
            : code === "invalid_policy"
              ? messages.errorInvalid
              : code === "administrator_required"
                ? messages.errorAdmin
                : messages.errorGeneric;
      props.reportError?.({ key: ID, message: t(message) });
    };
    const load = async () => {
      const generation = ++lifetime.current;
      setPending("load");
      try {
        const next = await controller.load();
        if (generation !== lifetime.current) return;
        const previous = shown.current,
          current = controller.draft,
          base = controller.draftRevision;
        shown.current = next;
        setDocument(next);
        setLoadFailed(false);
        // An unchanged editor follows the newest published document; real edits stay pinned to their base revision.
        if (
          !current ||
          base === null ||
          (previous !== null && base === previous.revision && sameDraft(current, draftFromRules(previous.rules)))
        ) {
          setDraft(draftFromRules(next.rules), next.revision);
        }
      } catch (error) {
        if (generation !== lifetime.current) return;
        setLoadFailed(true);
        report(error);
      } finally {
        if (generation === lifetime.current) setPending(null);
      }
    };
    useEffect(() => {
      void load();
      return () => {
        lifetime.current++;
      };
    }, []);

    const publish = async () => {
      if (!draft || controller.draftRevision === null) return;
      const generation = lifetime.current,
        edit = edits.current;
      setPending("publish");
      setPublishResult(null);
      try {
        const next = await controller.publish(controller.draftRevision, draft);
        if (generation !== lifetime.current) return;
        shown.current = next;
        setDocument(next);
        if (edit === edits.current) {
          setDraft(draftFromRules(next.rules), next.revision);
          setPublishResult(t(messages.publishedResult));
        }
      } catch (error) {
        if (generation !== lifetime.current) return;
        report(error);
        // Show the newer document so "Discard changes" loads it; the edits stay as they are.
        if (error instanceof LoginAdmissionRequestError && error.code === "revision_conflict") {
          setPending(null);
          void load();
          return;
        }
      } finally {
        if (generation === lifetime.current) setPending((p) => (p === "publish" ? null : p));
      }
    };
    const preview = async () => {
      if (!draft || !testValue.trim()) return;
      const generation = lifetime.current,
        edit = edits.current,
        value = testValue.trim();
      setPending("preview");
      setTestResult(null);
      try {
        const result = await controller.preview(draft, { value });
        if (generation !== lifetime.current || edit !== edits.current) return;
        setTestResult(
          result.allow
            ? t(messages.admitted, { rule: result.match ?? ("function" satisfies LoginAdmissionMatch) })
            : result.failed
              ? t(messages.refusedFailure)
              : t(messages.refused),
        );
      } catch (error) {
        if (generation === lifetime.current) report(error);
      } finally {
        if (generation === lifetime.current) setPending(null);
      }
    };

    const reload = (
      <IconButton
        aria-label={t(messages.reload)}
        title={t(messages.reload)}
        disabled={pending !== null}
        onClick={() => void load()}
      >
        <RefreshIcon />
      </IconButton>
    );
    const header = <SettingsPageHeader title={t(messages.title)} description={t(messages.description)} />;
    if (!document || !draft) {
      return (
        <>
          {header}
          <SettingsSection title={t(messages.policy)} action={loadFailed ? reload : undefined}>
            <SettingsNotice role="status">{loadFailed ? t(messages.loadFailed) : t(messages.loading)}</SettingsNotice>
          </SettingsSection>
        </>
      );
    }
    const published = draftFromRules(document.rules);
    const dirty = controller.draftRevision !== document.revision || !sameDraft(draft, published);
    const busy = pending !== null;
    const field = (
      key: "allowlist" | "patterns" | "conditions" | "admitFunction",
      label: { id: string; defaultMessage: string },
      description: { id: string; defaultMessage: string },
      code = false,
    ) => {
      const id = `${ids}-${key}`;
      return (
        <SettingsRow layout="stacked" label={t(label)} description={t(description)} htmlFor={id}>
          <textarea
            id={id}
            className={
              "settings-control-input login-admission__editor" + (code ? " login-admission__editor--code" : "")
            }
            value={draft[key]}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            rows={code ? 8 : 4}
            placeholder={code ? ADMIT_FUNCTION_EXAMPLE : undefined}
            onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
          />
        </SettingsRow>
      );
    };
    return (
      <>
        {header}
        <SettingsSection title={t(messages.policy)} action={reload}>
          <SettingsGroup>
            <SettingsRow
              label={t(messages.restrict)}
              description={t(messages.restrictDescription, { provider: document.scope.provider })}
              controlWidth="compact"
            >
              <SettingsSwitch
                checked={draft.enabled}
                label={t(messages.restrict)}
                disabled={busy}
                onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
              />
            </SettingsRow>
            <SettingsRow label={t(messages.attribute)} description={t(messages.attributeDescription)}>
              <span className="login-admission__value">
                {document.scope.provider} · {document.scope.attribute}
              </span>
            </SettingsRow>
            <SettingsRow label={t(messages.published)}>
              <span className="login-admission__value">
                {document.revision > 0 && document.updatedAt !== null
                  ? t(messages.publishedValue, {
                      revision: document.revision,
                      date: intl.formatDate(document.updatedAt, { dateStyle: "medium", timeStyle: "short" }),
                    })
                  : t(messages.neverPublished)}
              </span>
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>
        <SettingsSection title={t(messages.rules)} description={t(messages.rulesDescription)}>
          <SettingsGroup>
            {field("allowlist", messages.allowlist, messages.allowlistDescription)}
            {field("patterns", messages.patterns, messages.patternsDescription)}
            {field("conditions", messages.conditions, messages.conditionsDescription)}
            {field("admitFunction", messages.function, messages.functionDescription, true)}
          </SettingsGroup>
          <SettingsActions wrap>
            <SettingsButton disabled={busy || !dirty} onClick={() => setDraft(published, document.revision)}>
              {t(messages.discard)}
            </SettingsButton>
            <SettingsButton
              variant="primary"
              disabled={busy || !dirty}
              loading={pending === "publish"}
              onClick={() => void publish()}
            >
              {t(messages.publish)}
            </SettingsButton>
          </SettingsActions>
          <p className="login-admission__result" role="status">
            {publishResult ?? " "}
          </p>
        </SettingsSection>
        <SettingsSection title={t(messages.test)} description={t(messages.testDescription)}>
          <SettingsGroup>
            <SettingsRow label={t(messages.testValue, { attribute: document.scope.attribute })} htmlFor={`${ids}-test`}>
              <SettingsTextInput
                id={`${ids}-test`}
                value={testValue}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => {
                  setTestValue(event.target.value);
                  setTestResult(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) void preview();
                }}
              />
            </SettingsRow>
          </SettingsGroup>
          <SettingsActions>
            <SettingsButton
              disabled={busy || !testValue.trim()}
              loading={pending === "preview"}
              onClick={() => void preview()}
            >
              {t(messages.runTest)}
            </SettingsButton>
          </SettingsActions>
          <p className="login-admission__result" role="status">
            {testResult ?? " "}
          </p>
        </SettingsSection>
        {document.versions.length > 1 ? (
          <SettingsSection title={t(messages.history)}>
            <SettingsGroup>
              {document.versions
                .filter((version) => version.revision !== document.revision)
                .map((version) => (
                  <SettingsRow
                    key={version.revision}
                    label={t(messages.version, { revision: version.revision })}
                    description={intl.formatDate(version.at, { dateStyle: "medium", timeStyle: "short" })}
                  >
                    <SettingsButton disabled={busy} onClick={() => setDraft(draftFromRules(version.rules))}>
                      {t(messages.restore)}
                    </SettingsButton>
                  </SettingsRow>
                ))}
            </SettingsGroup>
          </SettingsSection>
        ) : null}
      </>
    );
  };
}

/**
 * Settings page for administrators of a server that enabled the policy. The
 * page is registered only after the server confirms both; the server still
 * authorizes every read and write.
 */
export function createLoginAdmissionExtension(fetcher: typeof fetch, url?: string): TrustedExtensionDefinition {
  const controller = new LoginAdmissionController(fetcher, url);
  const View = createLoginAdmissionView(controller);
  return {
    manifest: {
      manifestVersion: 1,
      id: ID,
      name: "Sign-in admission",
      version: "0.1.0",
      apiVersion: 1,
      trust: "trusted",
      platforms: ["web", "electron"],
      activationEvents: ["onStartupFinished"],
    },
    async activate(api) {
      api.subscriptions.add(() => controller.dispose());
      if (!(await controller.available())) return;
      api.views.register({
        id: ID + ".view",
        title: "Sign-in admission",
        viewType: ID + ".view",
        platforms: ["web", "electron"],
      });
      api.settings.registerPage({
        id: ID,
        title: "Sign-in admission",
        titleMessage: messages.title,
        viewId: ID + ".view",
        group: "Server",
        groupMessage: { id: "settings.groups.server", defaultMessage: "Server" },
        icon: "users",
        platforms: ["web", "electron"],
      });
      api.internal.register("platformViewRenderer", { viewType: ID + ".view", Component: View });
    },
  };
}
