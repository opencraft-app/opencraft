import { useIntl } from "@opencraft/i18n/react";
import {
  ModalSurface as SharedModalSurface,
  type ModalSurfaceProps as SharedModalSurfaceProps,
} from "@opencraft/design-system-web/modal-surface";

export type ModalSurfaceProps = Omit<SharedModalSurfaceProps, "closeLabel"> & { readonly closeLabel?: string };

/** Supplies the localized default close label to the shared modal adapter. */
export function ModalSurface({ closeLabel, ...props }: ModalSurfaceProps) {
  const intl = useIntl();
  return (
    <SharedModalSurface
      {...props}
      closeLabel={
        closeLabel ??
        intl.formatMessage(
          { id: "modal.closeLabel", defaultMessage: "Close {label}" },
          { label: props.label.toLocaleLowerCase() },
        )
      }
    />
  );
}
