import type { OptionalModalRequest } from "./modal-controller";
import { resolveModalStack } from "./modal-controller";
import { ModalSurface } from "./modal-surface";

export interface ModalHostProps {
  readonly requests: readonly OptionalModalRequest[];
}

/** The only Web projection point for application-owned modal windows. */
export function ModalHost({ requests }: ModalHostProps) {
  const stack = resolveModalStack(requests);

  return stack.map(({ content, id, onDismiss, stackIndex, ...descriptor }) => (
    <ModalSurface
      {...descriptor}
      key={id}
      onDismiss={onDismiss}
      stackIndex={stackIndex}
    >
      {content}
    </ModalSurface>
  ));
}

