import type { InternalContributionAdapter } from "@opencraft/extension-runtime";
import {
  ComposerActionRendererRegistry,
  type ComposerActionHost,
  type ComposerActionRendererContribution,
} from "@opencraft/extension-react";
import type {
  ComposerController,
  ComposerTransientTextInputObserver,
} from "@opencraft/composer-core";
import { assertOwnedContributionId } from "@opencraft/extension-contract";
import { useMemo, useSyncExternalStore } from "react";

export function createComposerActionRendererContributionAdapter(
  registry: ComposerActionRendererRegistry,
): InternalContributionAdapter {
  return {
    prepare(owner, value) {
      if (
        typeof value !== "object" ||
        value === null ||
        !("id" in value) ||
        !("Component" in value)
      ) {
        throw new TypeError("Composer action renderer contribution is invalid");
      }
      const contribution = value as ComposerActionRendererContribution;
      if (
        typeof contribution.id !== "string" ||
        typeof contribution.Component !== "function"
      ) {
        throw new TypeError("Composer action renderer requires id and Component");
      }
      assertOwnedContributionId(owner.extensionId, contribution.id);
      if (
        registry
          .getSnapshot()
          .actions.some((action) => action.id === contribution.id)
      ) {
        throw new Error(
          `Composer action renderer ${contribution.id} is already registered`,
        );
      }
      return {
        commit: () => registry.register(owner.activationId, contribution),
      };
    },
  };
}

export function ComposerExtensionActions({
  actionIds,
  registry,
  controller,
  disabled,
  platform,
}: {
  readonly actionIds: "all" | readonly string[];
  readonly registry: ComposerActionRendererRegistry;
  readonly controller: ComposerController;
  readonly disabled: boolean;
  readonly platform: ComposerActionHost["platform"];
}) {
  const snapshot = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  );
  const mutations = useMemo(
    () =>
      Object.freeze({
        insertText: (text: string) => controller.insertText(text),
        beginTransientTextInput: (observer?: ComposerTransientTextInputObserver) =>
          controller.beginTransientTextInput(observer),
        focus: () => controller.focus(),
      }),
    [controller],
  );
  const actions = actionIds === "all"
    ? snapshot.actions
    : snapshot.actions.filter(({ id }) => actionIds.includes(id));
  return actions.map(({ id, Component }) => (
    <Component
      key={id}
      disabled={disabled}
      mutations={mutations}
      platform={platform}
    />
  ));
}
