export interface ChromeActionFocusHost {
  readonly connected: boolean;
  readonly role?: ChromeActionHostRole;
  ownsFocus(): boolean;
  focus(options: { readonly preventScroll: true }): void;
}

export type ChromeActionHostRole = "persistent" | "transient";

/**
 * Preserves logical focus while one Chrome action moves between visual hosts.
 *
 * The docked header and floating sidebar may render separate DOM nodes for the
 * same action. Focus belongs to the action identity, not to either temporary
 * node, so removing the focused host hands focus to a connected peer during
 * the same commit.
 */
export class ChromeActionFocusRegistry {
  readonly #hostsByAction = new Map<string, Set<ChromeActionFocusHost>>();

  register(actionId: string, host: ChromeActionFocusHost): () => void {
    const hosts = this.#hostsByAction.get(actionId) ?? new Set<ChromeActionFocusHost>();
    hosts.add(host);
    this.#hostsByAction.set(actionId, hosts);

    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;

      const shouldTransferFocus = host.ownsFocus();
      hosts.delete(host);
      if (hosts.size === 0) this.#hostsByAction.delete(actionId);
      if (!shouldTransferFocus) return;

      const replacement = Array.from(hosts).findLast((candidate) => candidate.connected);
      replacement?.focus({ preventScroll: true });
    };
  }

  focus(actionId: string, role: ChromeActionHostRole): boolean {
    const target = Array.from(this.#hostsByAction.get(actionId) ?? [])
      .findLast(host => host.connected && host.role === role);
    if (!target) return false;
    target.focus({ preventScroll: true });
    return true;
  }

  transferFocus(
    actionId: string,
    fromRole: ChromeActionHostRole,
    toRole: ChromeActionHostRole,
  ): boolean {
    const hosts = this.#hostsByAction.get(actionId);
    if (hosts === undefined) return false;

    const source = Array.from(hosts).findLast(
      (host) => host.role === fromRole && host.connected && host.ownsFocus(),
    );
    if (source === undefined) return false;

    const destination = Array.from(hosts).findLast(
      (host) => host.role === toRole && host.connected,
    );
    if (destination === undefined) return false;

    destination.focus({ preventScroll: true });
    return true;
  }
}
