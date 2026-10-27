import {
  assertOwnedContributionId,
  type AnnouncementContribution,
  type AnnouncementDismissReason,
  type AnnouncementResult,
  type ExtensionActivationIdentity,
} from "@opencraft/extension-contract";

export interface OwnedAnnouncement {
  readonly key: string;
  readonly owner: ExtensionActivationIdentity;
  readonly contribution: AnnouncementContribution;
}

export interface AnnouncementCenterSnapshot {
  readonly revision: number;
  readonly announcements: readonly OwnedAnnouncement[];
}

interface AnnouncementRecord extends OwnedAnnouncement {
  readonly resolve: (result: AnnouncementResult) => void;
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (value.trim().length === 0) throw new RangeError(`${label} must not be empty`);
}

function isSupportedMediaUrl(url: string): boolean {
  return url.startsWith("/")
    || /^https?:\/\//iu.test(url)
    || url.startsWith("blob:")
    || /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+_-]+(?:=[^;,]*)?)*,/iu.test(url);
}

function validateAnnouncement(
  owner: ExtensionActivationIdentity,
  contribution: AnnouncementContribution,
): void {
  if (contribution === null || typeof contribution !== "object") {
    throw new TypeError("Announcement contribution must be an object");
  }
  requireText(contribution.id, "Announcement id");
  assertOwnedContributionId(owner.extensionId, contribution.id);
  requireText(contribution.title, `Announcement ${contribution.id} title`);
  if (contribution.body !== undefined) requireText(contribution.body, `Announcement ${contribution.id} body`);
  if (
    contribution.actionLayout !== undefined
    && contribution.actionLayout !== "inline"
    && contribution.actionLayout !== "stacked"
  ) {
    throw new RangeError(`Announcement ${contribution.id} has an invalid action layout`);
  }
  if (
    contribution.dismissOnOutsidePress !== undefined
    && typeof contribution.dismissOnOutsidePress !== "boolean"
  ) {
    throw new TypeError(`Announcement ${contribution.id} dismissOnOutsidePress must be a boolean`);
  }
  const actionIds = new Set<string>();
  for (const action of [contribution.primaryAction, contribution.secondaryAction]) {
    if (action === undefined) continue;
    if (action === null || typeof action !== "object") {
      throw new TypeError(`Announcement ${contribution.id} actions must be objects`);
    }
    requireText(action.id, `Announcement ${contribution.id} action id`);
    requireText(action.label, `Announcement ${contribution.id} action label`);
    if (actionIds.has(action.id)) {
      throw new Error(`Announcement ${contribution.id} contains duplicate action ${action.id}`);
    }
    actionIds.add(action.id);
  }
  if (contribution.media !== undefined) {
    if (contribution.media === null || typeof contribution.media !== "object") {
      throw new TypeError(`Announcement ${contribution.id} media must be an object`);
    }
    if (contribution.media.kind !== "image-url") {
      throw new RangeError(`Announcement ${contribution.id} has an invalid media kind`);
    }
    requireText(contribution.media.url, `Announcement ${contribution.id} media URL`);
    requireText(contribution.media.alt, `Announcement ${contribution.id} media alt text`);
    const url = contribution.media.url;
    if (!isSupportedMediaUrl(url)) {
      throw new RangeError(
        `Announcement ${contribution.id} media URL must be HTTP(S), blob, image data, or root-relative`,
      );
    }
  }
}

function freezeAnnouncement(contribution: AnnouncementContribution): AnnouncementContribution {
  return Object.freeze({
    ...contribution,
    ...(contribution.media === undefined ? {} : { media: Object.freeze({ ...contribution.media }) }),
    ...(contribution.primaryAction === undefined
      ? {}
      : { primaryAction: Object.freeze({ ...contribution.primaryAction }) }),
    ...(contribution.secondaryAction === undefined
      ? {}
      : { secondaryAction: Object.freeze({ ...contribution.secondaryAction }) }),
  });
}

/**
 * Renderer-free owner of imperative announcement requests. React Native and
 * Web subscribe to the same snapshot and project it through their ModalHost.
 */
export class AnnouncementCenter {
  private readonly records = new Map<string, AnnouncementRecord>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private closed = false;
  private snapshot: AnnouncementCenterSnapshot = { revision: 0, announcements: [] };

  getSnapshot = (): AnnouncementCenterSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  show(
    owner: ExtensionActivationIdentity,
    contribution: AnnouncementContribution,
  ): Promise<AnnouncementResult> {
    this.ensureOpen();
    validateAnnouncement(owner, contribution);
    const key = `${owner.activationId}\u0000${contribution.id}`;
    this.settle(key, { kind: "dismissed", reason: "replaced" });
    return new Promise<AnnouncementResult>((resolve) => {
      this.records.set(key, Object.freeze({ key, owner, contribution: freezeAnnouncement(contribution), resolve }));
      this.publish();
    });
  }

  choose(key: string, actionId: string): boolean {
    const record = this.records.get(key);
    if (record === undefined) return false;
    const valid = [record.contribution.primaryAction, record.contribution.secondaryAction]
      .some((action) => action?.id === actionId);
    if (!valid) throw new RangeError(`Announcement ${record.contribution.id} has no action ${actionId}`);
    return this.settle(key, { kind: "action", actionId });
  }

  dismiss(key: string, reason: AnnouncementDismissReason): boolean {
    return this.settle(key, { kind: "dismissed", reason });
  }

  dismissOwner(owner: ExtensionActivationIdentity): void {
    for (const record of [...this.records.values()]) {
      if (record.owner.activationId === owner.activationId) {
        this.settle(record.key, { kind: "dismissed", reason: "owner-disposed" });
      }
    }
  }

  close(): void {
    if (this.closed) return;
    for (const record of [...this.records.values()]) {
      this.settle(record.key, { kind: "dismissed", reason: "system" });
    }
    this.closed = true;
    this.listeners.clear();
  }

  private settle(key: string, result: AnnouncementResult): boolean {
    const record = this.records.get(key);
    if (record === undefined) return false;
    this.records.delete(key);
    record.resolve(result);
    this.publish();
    return true;
  }

  private publish(): void {
    this.revision += 1;
    this.snapshot = Object.freeze({
      revision: this.revision,
      announcements: Object.freeze(
        [...this.records.values()].map(({ resolve: _resolve, ...record }) => Object.freeze(record)),
      ),
    });
    if (this.closed) return;
    for (const listener of this.listeners) listener();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Announcement center is closed");
  }
}
