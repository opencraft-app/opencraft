import { AnimatePresence } from 'motion/react';
import type { OptionalModalRequest } from "./modal-controller";
import { resolveModalStack } from "./modal-controller";
import { ModalSurface } from "./modal-surface";
import { ConfirmationModalSurface } from "./confirmation-modal-surface";
import { useWorkbenchPresentationRoot } from "../workbench-presentation-root";
import { lazy, Suspense } from "react";

const NavigationHintSurface = lazy(() => import("./navigation-hint-surface").then(module => ({ default: module.NavigationHintSurface })));

export interface ModalHostProps {
  readonly requests: readonly OptionalModalRequest[];
}

/** The only Web projection point for application-owned modal windows. */
export function ModalHost({ requests }: ModalHostProps) {
  const portalContainer = useWorkbenchPresentationRoot();
  const stack = resolveModalStack(requests);

  return <AnimatePresence>{stack.map(({ content, id, onDismiss, stackIndex, confirmation, ...descriptor }) => confirmation ? (
    <ConfirmationModalSurface portalContainer={portalContainer} key={id} label={descriptor.label} size={descriptor.size === "workspace" ? "wide" : descriptor.size} confirmation={confirmation} onDismiss={onDismiss} stackIndex={stackIndex} returnFocus={descriptor.returnFocus}>{content}</ConfirmationModalSurface>
  ) : descriptor.anchorNavigationId ? (
    <Suspense key={id} fallback={null}><NavigationHintSurface {...descriptor} onDismiss={onDismiss}>
      {content}
    </NavigationHintSurface></Suspense>
  ) : (
    <Suspense key={id} fallback={null}>
      <ModalSurface
        {...descriptor}
        onDismiss={onDismiss}
        portalContainer={portalContainer}
        stackIndex={stackIndex}
      >
        {content}
      </ModalSurface>
    </Suspense>
  ))}</AnimatePresence>;
}
