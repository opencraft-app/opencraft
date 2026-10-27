import type { ModalDescriptor, ModalDismissReason } from "@opencraft/design-system/modal";
import type { ReactNode } from "react";

export interface ModalRequest extends ModalDescriptor {
  readonly confirmation?: { readonly confirmLabel: string; readonly cancelLabel?: string; readonly onConfirm: () => void };
  readonly id: string;
  readonly content: ReactNode;
  readonly className?: string;
  readonly onDismiss: (reason: ModalDismissReason) => void;
  readonly returnFocus?: () => HTMLElement | null;
}

export interface ModalStackEntry extends ModalRequest {
  readonly stackIndex: number;
}

export type OptionalModalRequest = ModalRequest | null | false | undefined;

export function resolveModalStack(
  requests: readonly OptionalModalRequest[],
): readonly ModalStackEntry[] {
  const order: string[] = [];
  const requestsById = new Map<string, ModalRequest>();

  for (const request of requests) {
    if (!request) continue;
    const existingIndex = order.indexOf(request.id);
    if (existingIndex >= 0) order.splice(existingIndex, 1);
    order.push(request.id);
    requestsById.set(request.id, request);
  }

  return order.map((id, stackIndex) => ({
    ...requestsById.get(id)!,
    stackIndex,
  }));
}
