import type { EmployeeGitVaultStore } from "../../../scripts/employee-git-vault-store";
import { PLATFORM_ASSET_SCOPE } from "./contract";

/** A declaration of an existing provider-managed NFS mount, not an OS mount command.
 * Registration is operator-only; public HTTP callers cannot grant storage access.
 * Credentials and NFS export paths are intentionally not part of this document. */
export interface ManagedNfsLibrary {
  id: string;
  name: string;
  kind: "nfs";
  managedBy: "e2b";
  mountPath: "/shared";
  credentialId: string;
  credentialGeneration: string;
  volumeId: string;
  environmentIds: string[];
  templateIds: string[];
  verifiedAt: string;
}
export type LibraryView = Pick<
  ManagedNfsLibrary,
  "id" | "name" | "kind" | "managedBy" | "mountPath" | "verifiedAt"
> & {
  source: "platform";
  environmentIds: string[];
  status: "configured" | "unavailable";
};
const namespace = "document-managed-nfs-libraries";
const keys = [
  "id",
  "name",
  "kind",
  "managedBy",
  "mountPath",
  "credentialId",
  "credentialGeneration",
  "volumeId",
  "environmentIds",
  "templateIds",
  "verifiedAt",
];
export function validateLibrary(
  value: unknown,
): asserts value is ManagedNfsLibrary {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("invalid_library");
  const v = value as ManagedNfsLibrary;
  if (
    Object.keys(v).some((k) => !keys.includes(k)) ||
    v.kind !== "nfs" ||
    v.managedBy !== "e2b" ||
    v.mountPath !== "/shared" ||
    ![v.id, v.name, v.credentialId, v.credentialGeneration, v.volumeId].every(
      (s) =>
        typeof s === "string" &&
        s.trim() === s &&
        s.length > 0 &&
        s.length <= 160 &&
        !/[\x00-\x1f\x7f]/u.test(s),
    ) ||
    !Array.isArray(v.environmentIds) ||
    v.environmentIds.length < 1 ||
    v.environmentIds.length > 32 ||
    new Set(v.environmentIds).size !== v.environmentIds.length ||
    !Array.isArray(v.templateIds) ||
    v.templateIds.length !== v.environmentIds.length ||
    !v.templateIds.every(
      (s) => typeof s === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(s),
    ) ||
    !v.environmentIds.every(
      (s) => typeof s === "string" && /^[a-zA-Z0-9_-]{1,160}$/u.test(s),
    ) ||
    typeof v.verifiedAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT/.test(v.verifiedAt) ||
    !Number.isFinite(Date.parse(v.verifiedAt))
  )
    throw Error("invalid_library");
}
export class ManagedNfsLibraries {
  constructor(
    private vault: Pick<
      EmployeeGitVaultStore,
      "readDocument" | "writeDocument"
    >,
  ) {}
  read() {
    const { revision, document } = this.vault.readDocument(
      PLATFORM_ASSET_SCOPE,
      namespace,
    );
    if (document === null)
      return { revision, libraries: [] as ManagedNfsLibrary[] };
    const d = document as { version: number; libraries: ManagedNfsLibrary[] };
    if (
      !d ||
      d.version !== 1 ||
      Object.keys(d).some((k) => !["version", "libraries"].includes(k)) ||
      !Array.isArray(d.libraries) ||
      d.libraries.length > 32
    )
      throw Error("invalid_library");
    d.libraries.forEach(validateLibrary);
    if (new Set(d.libraries.map((l) => l.id)).size !== d.libraries.length)
      throw Error("invalid_library");
    return { revision, libraries: structuredClone(d.libraries) };
  }
  /** Only a trusted operator uses this after verifying both mount and provider volume identity. */
  register(library: ManagedNfsLibrary, expectedRevision: number) {
    validateLibrary(library);
    const before = this.read();
    if (before.revision !== expectedRevision) throw Error("library_conflict");
    const libraries = before.libraries
      .filter((l) => l.id !== library.id)
      .concat(structuredClone(library));
    if (libraries.length > 32) throw Error("library_limit");
    this.vault.writeDocument(
      PLATFORM_ASSET_SCOPE,
      namespace,
      expectedRevision,
      { version: 1, libraries },
    );
  }
  snapshot(
    bindings: {
      environmentId: string;
      templateId: string;
      credentialId: string;
      credentialGeneration: string;
    }[],
  ) {
    const { revision, libraries } = this.read();
    return {
      revision,
      libraries: libraries.map((l) => {
        const environmentIds = l.environmentIds.filter((id, index) =>
          bindings.some(
            (b) =>
              b.environmentId === id &&
              b.templateId === l.templateIds[index] &&
              b.credentialId === l.credentialId &&
              b.credentialGeneration === l.credentialGeneration,
          ),
        );
        return {
          id: l.id,
          name: l.name,
          kind: l.kind,
          managedBy: l.managedBy,
          mountPath: l.mountPath,
          verifiedAt: l.verifiedAt,
          source: "platform" as const,
          environmentIds,
          status: environmentIds.length
            ? ("configured" as const)
            : ("unavailable" as const),
        };
      }),
    };
  }
}
