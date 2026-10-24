import type { OptionalModalRequest } from "./modal-controller";
import { resolveModalStack } from "./modal-controller";
import { ModalSurface } from "./modal-surface";
import { ConfirmationModalSurface } from "./confirmation-modal-surface";
import { useWorkbenchPresentationRoot } from "../workbench-presentation-root";

export interface ModalHostProps {
  readonly requests: readonly OptionalModalRequest[];
}

/** The only Web projection point for application-owned modal windows. */
export function ModalHost({ requests }: ModalHostProps) {
  const portalContainer = useWorkbenchPresentationRoot();
  const stack = resolveModalStack(requests);

  return stack.map(({ content, id, onDismiss, stackIndex, confirmation, ...descriptor }) => confirmation ? (
    <ConfirmationModalSurface portalContainer={portalContainer} key={id} label={descriptor.label} confirmation={confirmation} onDismiss={onDismiss} stackIndex={stackIndex} returnFocus={descriptor.returnFocus}>{content}</ConfirmationModalSurface>
  ) : (
    <ModalSurface
      {...descriptor}
      key={id}
      onDismiss={onDismiss}
      portalContainer={portalContainer}
      stackIndex={stackIndex}
    >
      {content}
    </ModalSurface>
  ));
}
