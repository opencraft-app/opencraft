import { useMemo, type ComponentType } from "react";
import { useIntl } from "@opencraft/i18n/react";
import {
  EnvironmentVariablesEditor,
  type EnvironmentEditorLabels,
  type EnvironmentEditorPort,
} from "@opencraft/extension-react";
import { parseEnvironmentDocument } from "@opencraft/workbench-runtime";
import type { AssetsAccount, AssetVariablesProps } from "./ports";

/** The server route of the signed-in person's ENV (`AccountEnvironmentHttp`). */
export const ASSET_ENVIRONMENT_ENDPOINT = "/__opencraft_assets/environment";

const messages = {
  title: { id: "assets.env.title", defaultMessage: "Personal variables" },
  scope: { id: "assets.env.scope", defaultMessage: "Scope" },
  allProjects: { id: "assets.env.allProjects", defaultMessage: "All my projects" },
  description: {
    id: "assets.env.description",
    defaultMessage:
      "New tasks you start use these values. Project variables take priority; changes apply to new processes.",
  },
  variables: { id: "assets.env.variables", defaultMessage: "Variables" },
  add: { id: "assets.env.add", defaultMessage: "Add variable" },
  edit: { id: "assets.env.edit", defaultMessage: "Edit" },
  remove: { id: "assets.env.remove", defaultMessage: "Delete" },
  save: { id: "assets.env.save", defaultMessage: "Save" },
  saving: { id: "assets.env.saving", defaultMessage: "Saving…" },
  cancel: { id: "assets.env.cancel", defaultMessage: "Cancel" },
  name: { id: "assets.env.name", defaultMessage: "Name" },
  value: { id: "assets.env.value", defaultMessage: "Value" },
  secret: { id: "assets.env.secret", defaultMessage: "Secret" },
  savedSecret: { id: "assets.env.savedSecret", defaultMessage: "Saved. Enter a new value to replace it." },
  inherited: { id: "assets.env.inherited", defaultMessage: "From all my projects" },
  empty: { id: "assets.env.empty", defaultMessage: "No variables yet" },
  loading: { id: "assets.env.loading", defaultMessage: "Loading…" },
  retry: { id: "assets.env.retry", defaultMessage: "Retry" },
  failed: { id: "assets.env.failed", defaultMessage: "Variables could not be loaded or saved. Try again." },
  invalid: {
    id: "assets.env.invalid",
    defaultMessage: "Check the name and value. To turn off Secret, enter the value again.",
  },
  reserved: {
    id: "assets.env.reserved",
    defaultMessage: "This name is reserved by the platform. Choose another name.",
  },
  conflict: {
    id: "assets.env.conflict",
    defaultMessage: "Variables changed in another window. Reopen this page and try again.",
  },
} satisfies Record<keyof EnvironmentEditorLabels, { id: string; defaultMessage: string }>;

/** One account-fenced adapter; the server is the only writer and never returns
 * a saved secret value. A response for another account is discarded. */
export function createAssetEnvironmentPort(
  fetcher: typeof fetch,
  account: AssetsAccount,
  scope: string,
  endpoint = ASSET_ENVIRONMENT_ENDPOINT,
): EnvironmentEditorPort {
  const fence = () => {
    if (account.getScope() !== scope) throw new Error("unauthenticated");
  };
  const request = async (projectId: string | null, signal: AbortSignal, body?: unknown) => {
    signal.throwIfAborted();
    fence();
    const response = await fetcher(
      endpoint + (body === undefined && projectId !== null ? `?projectId=${encodeURIComponent(projectId)}` : ""),
      {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal,
        headers: {
          "x-opencraft-account-scope": scope,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    signal.throwIfAborted();
    fence();
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => null);
      const code = error && typeof error === "object" && "error" in error ? String(error.error) : "";
      if (response.status === 401 || response.status === 403) void account.refresh();
      throw new Error(["reserved", "invalid", "conflict"].includes(code) ? code : "unavailable");
    }
    const result = parseEnvironmentDocument(await response.json());
    signal.throwIfAborted();
    fence();
    if (result.projectId !== projectId) throw new Error("invalid");
    return result;
  };
  return {
    load: (projectId, signal) => request(projectId, signal),
    save: (document, variables, signal) =>
      request(document.projectId, signal, { projectId: document.projectId, revision: document.revision, variables }),
  };
}

/** The default personal ENV editor of the Assets page: the shared editor owns
 * the form, drafts and pending state; Assets owns navigation. */
export function createAssetVariablesEditor(
  fetcher: typeof fetch,
  account: AssetsAccount,
  endpoint = ASSET_ENVIRONMENT_ENDPOINT,
): ComponentType<AssetVariablesProps> {
  return function AssetVariablesEditor({ scope, onStateChange }: AssetVariablesProps) {
    const intl = useIntl();
    const port = useMemo(() => createAssetEnvironmentPort(fetcher, account, scope, endpoint), [scope]);
    const labels = Object.fromEntries(
      Object.entries(messages).map(([key, message]) => [key, intl.formatMessage(message)]),
    ) as unknown as EnvironmentEditorLabels;
    return <EnvironmentVariablesEditor key={scope} port={port} labels={labels} onStateChange={onStateChange} />;
  };
}
