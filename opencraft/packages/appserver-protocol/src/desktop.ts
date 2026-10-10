/** Optional backend extension. Never forward these methods to native Codex. */
export const OPENCRAFT_DESKTOP_EXTENSION = "opencraft/desktop";
export const OPENCRAFT_DESKTOP_ATTACH = "opencraft/desktop/attachment/create";
export const OPENCRAFT_DESKTOP_RELEASE = "opencraft/desktop/attachment/release";

export interface HostDesktopCapability {
  readonly version: 1;
  readonly observe: true;
  readonly control: boolean;
  readonly transport: "same-origin-loopback" | "same-origin-trusted-internal";
  readonly serverId: string;
  readonly environmentId: string;
  readonly principalId: string;
  /** Explicit support for reauthorizing an already claimed viewer in place. */
  readonly renewable?: boolean;
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);

export function parseHostDesktopCapability(value: unknown): HostDesktopCapability | null {
  const dto = object(value);
  if (dto.version !== 1 || dto.observe !== true || typeof dto.control !== "boolean"
    || (dto.transport !== "same-origin-loopback" && dto.transport !== "same-origin-trusted-internal")
    || !id(dto.serverId) || !id(dto.environmentId) || !id(dto.principalId)
    || (dto.renewable !== undefined && typeof dto.renewable !== "boolean")) return null;
  return Object.freeze({ version: 1, observe: true, control: dto.control, transport: dto.transport,
    serverId: dto.serverId, environmentId: dto.environmentId, principalId: dto.principalId,
    ...(dto.renewable === undefined ? {} : { renewable: dto.renewable }) });
}

export interface HostDesktopTarget {
  readonly conversationId: string;
  readonly serverId: string;
  readonly environmentId: string;
  readonly principalId: string;
}

export interface HostDesktopCredential {
  readonly version: 1;
  readonly target: HostDesktopTarget;
  readonly instanceId: string;
  readonly resourceId: string;
  readonly bindingRevision: string;
  readonly preparationGenerationId: string;
  readonly incarnation: string;
  readonly attachmentId: string;
  readonly ticket: string;
  readonly expiresAt: number;
}

export function parseHostDesktopCredential(value: unknown): HostDesktopCredential | null {
  const dto = object(value), target = object(dto.target);
  if (dto.version !== 1 || !id(target.conversationId) || !id(target.serverId) || !id(target.environmentId)
    || !id(target.principalId) || !id(dto.instanceId) || !id(dto.resourceId) || !id(dto.bindingRevision)
    || !id(dto.preparationGenerationId) || !id(dto.incarnation)
    || typeof dto.attachmentId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(dto.attachmentId)
    || typeof dto.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(dto.ticket)
    || typeof dto.expiresAt !== "number" || !Number.isSafeInteger(dto.expiresAt)) return null;
  return Object.freeze({ version: 1, target: Object.freeze({ conversationId: target.conversationId,
    serverId: target.serverId, environmentId: target.environmentId, principalId: target.principalId }),
    instanceId: dto.instanceId, resourceId: dto.resourceId, bindingRevision: dto.bindingRevision,
    preparationGenerationId: dto.preparationGenerationId, incarnation: dto.incarnation,
    attachmentId: dto.attachmentId, ticket: dto.ticket, expiresAt: dto.expiresAt });
}
