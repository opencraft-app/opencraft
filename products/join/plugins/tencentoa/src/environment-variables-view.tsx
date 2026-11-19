import { useMemo } from "react";
import { useIntl } from "@opencraft/i18n/react";
import {
  EnvironmentVariablesEditor,
  type EnvironmentEditorLabels,
} from "@opencraft/extension-react";
import type { TencentOaController } from "./controller";
import { createPersonalEnvironmentPort } from "./environment-variables-port";

/** Product boundary only: identity-scoped HTTP adapter and translated copy.
 * The shared editor owns all form state; Assets owns navigation. */
export function PersonalEnvironmentVariables({
  controller,
  fetcher,
  scope,
  onStateChange,
}: {
  controller: TencentOaController;
  fetcher: typeof fetch;
  scope: string;
  onStateChange(state: { dirty: boolean; writing: boolean }): void;
}) {
  const intl = useIntl();
  const port = useMemo(
    () => createPersonalEnvironmentPort(controller, fetcher, scope),
    [controller, fetcher, scope],
  );
  const labels: EnvironmentEditorLabels = {
    title: intl.formatMessage({
      id: "ioa.env.title",
      defaultMessage: "Personal credentials ENV",
    }),
    scope: intl.formatMessage({ id: "ioa.env.scope", defaultMessage: "Scope" }),
    allProjects: intl.formatMessage({
      id: "ioa.env.allProjects",
      defaultMessage: "All my projects",
    }),
    description: intl.formatMessage({
      id: "ioa.env.description",
      defaultMessage:
        "New tasks use your credentials. Project variables take priority; changes apply to new processes.",
    }),
    variables: intl.formatMessage({
      id: "ioa.env.variables",
      defaultMessage: "Variables",
    }),
    add: intl.formatMessage({
      id: "ioa.env.add",
      defaultMessage: "Add variable",
    }),
    edit: intl.formatMessage({ id: "ioa.env.edit", defaultMessage: "Edit" }),
    remove: intl.formatMessage({
      id: "ioa.env.remove",
      defaultMessage: "Delete",
    }),
    save: intl.formatMessage({ id: "ioa.env.save", defaultMessage: "Save" }),
    saving: intl.formatMessage({
      id: "ioa.env.saving",
      defaultMessage: "Saving…",
    }),
    cancel: intl.formatMessage({
      id: "ioa.env.cancel",
      defaultMessage: "Cancel",
    }),
    name: intl.formatMessage({ id: "ioa.env.name", defaultMessage: "Name" }),
    value: intl.formatMessage({ id: "ioa.env.value", defaultMessage: "Value" }),
    secret: intl.formatMessage({
      id: "ioa.env.secret",
      defaultMessage: "Secret",
    }),
    savedSecret: intl.formatMessage({
      id: "ioa.env.savedSecret",
      defaultMessage: "Saved. Enter a new value to replace.",
    }),
    inherited: intl.formatMessage({
      id: "ioa.env.inherited",
      defaultMessage: "All my projects",
    }),
    empty: intl.formatMessage({
      id: "ioa.env.empty",
      defaultMessage: "No variables yet",
    }),
    loading: intl.formatMessage({
      id: "ioa.env.loading",
      defaultMessage: "Loading…",
    }),
    retry: intl.formatMessage({ id: "ioa.env.retry", defaultMessage: "Retry" }),
    failed: intl.formatMessage({
      id: "ioa.env.failed",
      defaultMessage: "Unable to load or save variables. Please retry.",
    }),
    invalid: intl.formatMessage({
      id: "ioa.env.invalid",
      defaultMessage:
        "Check the name and value. Re-enter the value to turn off Secret.",
    }),
    reserved: intl.formatMessage({
      id: "ioa.env.reserved",
      defaultMessage:
        "This name is reserved by the platform. Choose another name.",
    }),
    conflict: intl.formatMessage({
      id: "ioa.env.conflict",
      defaultMessage:
        "Variables changed in another window. Reopen this page and try again.",
    }),
  };
  return (
    <EnvironmentVariablesEditor
      key={scope}
      port={port}
      labels={labels}
      onStateChange={onStateChange}
    />
  );
}
