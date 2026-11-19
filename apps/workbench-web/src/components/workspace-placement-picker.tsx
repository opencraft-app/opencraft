import { useEffect, useId } from "react";
import type { ComposerExecutionTarget } from "@opencraft/composer-core";
import type { WorkspaceCatalog } from "@opencraft/appserver-protocol";
import { FormattedMessage, useIntl } from "@opencraft/i18n/react";
import { DisclosureButton } from "@opencraft/design-system-web/button";
import * as Menu from "@opencraft/design-system-web/dropdown-menu";
import { CheckIcon, ChevronDownIcon } from "@opencraft/design-system-web/action-icons";
import { menuGeometry } from "@opencraft/design-system/tokens";
import {
  libraryAvailable,
  sameEnvironment,
  selectPlacementEnvironment,
  selectPlacementSource,
} from "../runtime/workspace-placement-model";

import { useAsyncNotices } from "./async-notices-context";

export interface WorkspacePlacementControl {
  readonly catalog?: WorkspaceCatalog;
  readonly available: boolean;
  readonly selectable: boolean;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly problem: string | null;
  refresh(): void;
  select(execution: ComposerExecutionTarget): void;
}
export function WorkspacePlacementPicker({
  control,
  execution,
  locked,
  portalContainer,
  onReturnFocus,
}: {
  control: WorkspacePlacementControl;
  execution: ComposerExecutionTarget;
  locked: boolean;
  portalContainer: HTMLElement | null;
  onReturnFocus(): void;
}) {
  const intl = useIntl();
  const notices = useAsyncNotices();
  const noticeKey = useId();
  const selectionMessage = intl.formatMessage({
    id: "workspacePlacement.selectionRetained",
    defaultMessage: "Your selection is retained. Choose an empty workspace before changing environments.",
  });
  useEffect(() => {
    if (control.problem) notices.error({ key: noticeKey, message: selectionMessage });
    else if (control.error)
      notices.error({
        key: noticeKey,
        message: intl.formatMessage({
          id: "workspacePlacement.unavailable",
          defaultMessage: "Workspace choices are unavailable. Your selection is retained.",
        }),
      });
  }, [control.problem, control.error, intl, notices, noticeKey, selectionMessage]);
  const catalog = control.catalog;
  const environment = execution.environment;
  const source = execution.workspace.source;
  const environmentName =
    catalog?.environments.find((entry) => sameEnvironment(entry.target, environment))?.name ??
    environment?.configurationId;
  const libraryName =
    source?.kind === "library-reference"
      ? (catalog?.libraries.find((library) => library.id === source.libraryId)?.name ?? source.libraryId)
      : source?.kind;
  const change = (action: () => ComposerExecutionTarget, event?: Event) => {
    try {
      control.select(action());
      notices.dismiss(noticeKey);
    } catch {
      event?.preventDefault();
      notices.error({ key: noticeKey, message: selectionMessage });
    }
  };
  const contentProps = {
    className: "new-thread-project-menu",
    align: "start" as const,
    side: "top" as const,
    sideOffset: menuGeometry.rootSideOffset,
    collisionPadding: menuGeometry.collisionPadding,
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      onReturnFocus();
    },
  };
  const empty = (
    <Menu.Item
      className="new-thread-project-menu__item"
      disabled={locked}
      onSelect={() => change(() => ({ ...execution, workspace: { cwd: null, runtimeWorkspaceRoots: [] } }))}
    >
      <FormattedMessage id="workspacePlacement.empty" defaultMessage="Use an empty workspace" />
    </Menu.Item>
  );
  const status = (
    <Menu.Item
      className="new-thread-project-menu__item"
      disabled={!control.available || control.loading}
      onSelect={control.refresh}
      aria-busy={control.loading || undefined}
    >
      {control.loading ? (
        <FormattedMessage id="workspacePlacement.loading" defaultMessage="Refreshing workspaces…" />
      ) : (
        <FormattedMessage id="workspacePlacement.refresh" defaultMessage="Refresh workspaces" />
      )}
    </Menu.Item>
  );
  return (
    <>
      <Menu.Root
        onOpenChange={(open) => {
          if (open) control.refresh();
        }}
      >
        <Menu.Trigger asChild>
          <DisclosureButton
            className="new-thread-context-trigger"
            disabled={locked}
            aria-label={intl.formatMessage({ id: "workspacePlacement.environment", defaultMessage: "Run environment" })}
          >
            <span>
              {environmentName ??
                intl.formatMessage({ id: "workspacePlacement.host", defaultMessage: "Host workspace" })}
            </span>
            <ChevronDownIcon size={12} />
          </DisclosureButton>
        </Menu.Trigger>
        <Menu.Portal container={portalContainer}>
          <Menu.Content {...contentProps}>
            <Menu.Item
              className="new-thread-project-menu__item"
              disabled={locked}
              onSelect={(event) =>
                change(
                  () =>
                    selectPlacementEnvironment(
                      execution,
                      undefined,
                      catalog ?? { version: 1, environments: [], libraries: [] },
                    ),
                  event,
                )
              }
            >
              <FormattedMessage id="workspacePlacement.host" defaultMessage="Host workspace" />
              {!environment ? <CheckIcon size={15} /> : null}
            </Menu.Item>
            {catalog?.environments.map((entry) => (
              <Menu.Item
                key={JSON.stringify(entry.target)}
                className="new-thread-project-menu__item"
                disabled={locked || !control.selectable}
                onSelect={(event) => change(() => selectPlacementEnvironment(execution, entry.target, catalog), event)}
              >
                <span>
                  <strong>{entry.name}</strong>
                  <small>
                    <FormattedMessage id="workspacePlacement.configured" defaultMessage="Configured" /> ·{" "}
                    <FormattedMessage
                      id="workspacePlacement.resources"
                      defaultMessage="{cpu} CPU · {memory} GiB"
                      values={{
                        cpu: entry.resources.cpuMillis / 1000,
                        memory: Math.round(entry.resources.memoryBytes / 1024 ** 3),
                      }}
                    />
                  </small>
                </span>
                {sameEnvironment(environment, entry.target) ? <CheckIcon size={15} /> : null}
              </Menu.Item>
            ))}
            {empty}
            {status}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      {environment ? (
        <Menu.Root
          onOpenChange={(open) => {
            if (open) control.refresh();
          }}
        >
          <Menu.Trigger asChild>
            <DisclosureButton
              className="new-thread-context-trigger"
              disabled={locked}
              aria-label={intl.formatMessage({ id: "workspacePlacement.source", defaultMessage: "Workspace source" })}
            >
              <span>
                {libraryName ??
                  intl.formatMessage({ id: "workspacePlacement.emptyLabel", defaultMessage: "Empty workspace" })}
              </span>
              <ChevronDownIcon size={12} />
            </DisclosureButton>
          </Menu.Trigger>
          <Menu.Portal container={portalContainer}>
            <Menu.Content {...contentProps}>
              {empty}
              {catalog?.libraries.map((library) => (
                <Menu.Item
                  key={library.id}
                  className="new-thread-project-menu__item"
                  disabled={locked || !control.selectable || !libraryAvailable(catalog, library.id, environment)}
                  onSelect={() =>
                    change(() =>
                      selectPlacementSource(
                        execution,
                        { version: 1, kind: "library-reference", libraryId: library.id, relativePath: "" },
                        catalog,
                      ),
                    )
                  }
                >
                  <span>
                    <strong>{library.name}</strong>
                    {!libraryAvailable(catalog, library.id, environment) ? (
                      <small>
                        <FormattedMessage
                          id="workspacePlacement.incompatible"
                          defaultMessage="Unavailable in this environment"
                        />
                      </small>
                    ) : null}
                  </span>
                  {source?.kind === "library-reference" && source.libraryId === library.id ? (
                    <CheckIcon size={15} />
                  ) : null}
                </Menu.Item>
              ))}
              {status}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      ) : null}
    </>
  );
}
