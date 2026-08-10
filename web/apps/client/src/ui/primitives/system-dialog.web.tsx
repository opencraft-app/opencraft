import type {KeyboardEvent} from "react";
import {useEffect, useRef} from "react";
import {Dialog} from "react-aria-components/Dialog";
import {Modal, ModalOverlay} from "react-aria-components/Modal";
import {useUnistyles} from "react-native-unistyles";

import type {
  DialogCloseReason,
  SystemDialogAction,
  SystemDialogProps,
} from "./system-dialog.types";
import {webTypography} from "./web-typography";

export type {
  DialogCloseReason,
  SystemDialogAction,
  SystemDialogProps,
} from "./system-dialog.types";

export function SystemDialog({
  actions,
  atomicLock = false,
  busy = false,
  children,
  description,
  dialogId,
  dismissOnBackdrop = false,
  initialFocusId,
  onAction,
  onOpenChange,
  open,
  title,
  urgency = "normal",
}: SystemDialogProps) {
  const {theme} = useUnistyles();
  const openerRef = useRef<HTMLElement | null>(null);
  const closingReason = useRef<DialogCloseReason | null>(null);
  const wasOpen = useRef(false);
  const locked = atomicLock && busy;

  useEffect(() => {
    if (open && !wasOpen.current) {
      closingReason.current = null;
      openerRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      requestAnimationFrame(() => {
        const explicit = initialFocusId
          ? document.getElementById(initialFocusId)
          : null;
        const cancel = document.getElementById(
          `${dialogId}-action-${actions.find(action => action.kind === "cancel")?.id ?? ""}`,
        );
        const safeAction = actions.find(
          action => !action.disabled && action.intent !== "destructive",
        );
        const safe = safeAction
          ? document.getElementById(`${dialogId}-action-${safeAction.id}`)
          : null;
        const panel = document.getElementById(dialogId);
        (explicit ?? cancel ?? safe ?? panel)?.focus();
      });
    }
    wasOpen.current = open;
  }, [actions, dialogId, initialFocusId, open]);

  const restoreFocus = () => {
    const opener = openerRef.current;
    requestAnimationFrame(() => {
      if (opener?.isConnected) opener.focus();
    });
  };
  const close = (reason: DialogCloseReason) => {
    if (locked || closingReason.current) return;
    closingReason.current = reason;
    onOpenChange(false, reason);
    restoreFocus();
  };
  const activate = (action: SystemDialogAction) => {
    if (action.disabled || (busy && action.kind === "action") || locked) return;
    onAction(action.id);
    close(action.kind === "cancel" ? "cancel" : "action");
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || locked) return;
    event.preventDefault();
    event.stopPropagation();
    close("escape");
  };

  const titleId = `${dialogId}-title`;
  const descriptionId = `${dialogId}-description`;
  return (
    <ModalOverlay
      isDismissable={dismissOnBackdrop && !locked}
      isKeyboardDismissDisabled={locked}
      isOpen={open}
      onOpenChange={next => {
        if (!next && open && !closingReason.current) {
          close(dismissOnBackdrop ? "backdrop" : "escape");
        }
      }}
      style={{
        alignItems: "center",
        background: theme.semantic.color.modalBackdrop,
        display: "flex",
        inset: 0,
        justifyContent: "center",
        padding: theme.spacing.lg,
        position: "fixed",
        zIndex: theme.semantic.layer.modal,
      }}
    >
      <div onKeyDownCapture={handleKeyDown} style={{display: "contents"}}>
        <Modal
          data-vela-material="dialog"
          style={{
            boxSizing: "border-box",
            maxHeight: "calc(100vh - 32px)",
            maxWidth: theme.recipes.overlay.confirmDialogMaxWidth,
            outline: "none",
            width: "100%",
          }}
        >
        <Dialog
          aria-describedby={descriptionId}
          aria-labelledby={titleId}
          id={dialogId}
          role={urgency === "urgent" ? "alertdialog" : "dialog"}
          style={{
            backdropFilter: theme.semantic.material.blur,
            background: theme.semantic.material.composerFill,
            border: `${theme.semantic.stroke.hairline}px solid ${theme.semantic.color.borderOverlay}`,
            borderRadius: theme.semantic.radius.overlay,
            boxShadow: `0 ${theme.shadows.overlay.offsetY}px ${theme.shadows.overlay.radius}px ${theme.shadows.overlay.color}`,
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            gap: theme.spacing.lg,
            maxHeight: "calc(100vh - 32px)",
            outline: "none",
            overflow: "hidden",
            padding: 0,
            WebkitBackdropFilter: theme.semantic.material.blur,
          }}
        >
          <div style={{
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
            gap: theme.spacing.xs,
            padding: `${theme.spacing.xl}px ${theme.spacing.xl}px 0`,
          }}>
            <h2 id={titleId} style={{
              ...webTypography(theme.semantic.typography.dialogTitle),
              color: theme.semantic.color.textPrimary,
              margin: 0,
            }}>{title}</h2>
            <p id={descriptionId} style={{
              ...webTypography(theme.semantic.typography.bodyCompact),
              color: theme.semantic.color.textMuted,
              margin: 0,
            }}>{description}</p>
          </div>
          {children ? (
            <div
              data-testid="system-dialog-content"
              style={{
                minHeight: 0,
                overflowX: "hidden",
                overflowY: "auto",
                padding: `0 ${theme.spacing.xl}px`,
              }}
            >
              {children}
            </div>
          ) : null}
          <div
            data-testid="system-dialog-actions"
            style={{
              display: "flex",
              flexShrink: 0,
              flexWrap: "wrap",
              gap: theme.spacing.sm,
              justifyContent: "flex-end",
              padding: `0 ${theme.spacing.xl}px ${theme.spacing.xl}px`,
            }}
          >
            {actions.map(action => {
              const unavailable = Boolean(
                action.disabled || locked || (busy && action.kind === "action"),
              );
              const emphasized = action.intent === "default" || action.intent === "destructive";
              const destructive = action.intent === "destructive";
              return (
                <button
                  aria-busy={busy && action.kind === "action"}
                  disabled={unavailable}
                  id={`${dialogId}-action-${action.id}`}
                  key={action.id}
                  onClick={() => activate(action)}
                  style={{
                    ...webTypography(theme.semantic.typography.button),
                    background: destructive
                      ? theme.semantic.color.actionDangerEmphasisSurface
                      : emphasized
                        ? theme.semantic.color.actionPrimarySurface
                        : theme.semantic.color.actionSecondarySurface,
                    border: `${theme.semantic.stroke.hairline}px solid ${
                      destructive
                        ? theme.semantic.color.actionDangerEmphasisSurface
                        : emphasized
                          ? theme.semantic.color.actionPrimarySurface
                          : theme.semantic.color.borderControl
                    }`,
                    borderRadius: theme.semantic.radius.control,
                    color: destructive
                      ? theme.semantic.color.actionDangerEmphasisText
                      : emphasized
                        ? theme.semantic.color.actionPrimaryText
                        : theme.semantic.color.actionSecondaryText,
                    cursor: unavailable ? "not-allowed" : "default",
                    height: theme.recipes.control.height,
                    minWidth: 76,
                    opacity: unavailable ? theme.semantic.interaction.disabledOpacity : 1,
                    padding: `0 ${theme.spacing.md}px`,
                  }}
                  type="button"
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        </Dialog>
        </Modal>
      </div>
    </ModalOverlay>
  );
}
