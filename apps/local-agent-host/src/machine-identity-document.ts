// Machine identity over a state document (runtime-neutral). The Node owner
// keeps the same identity in `<dataDirectory>/machine-id`
// (`./machine-identity.ts`); a single-writer owner without a file system keeps
// it as one StateDocumentStore entry. Either way the ID is created once and
// never changes; a configured name never changes it.
import { parseRuntimeMachineIdentity, type RuntimeMachineIdentity } from "@opencraft/appserver-protocol";
import type { StateDocumentStore } from "@opencraft/document-storage/state";

/** The document key; the Node owner's file has the same name. */
export const MACHINE_IDENTITY_DOCUMENT = "machine-id";

/** A deployment may name the machine; the name never changes machineId. */
export function configuredMachineName(value: string | undefined): string | null {
  const name = value?.trim() ?? "";
  if (name === "") return null;
  if (name.length > 64 || /\p{Cc}/u.test(name))
    throw new Error("--machine-name must be at most 64 characters without control characters");
  return name;
}

const persistedMachineId = (value: unknown): string => {
  const machineId = (value as { machineId?: unknown } | null)?.machineId;
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).length !== 1 ||
    typeof machineId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(machineId)
  )
    throw new Error("Invalid persisted Host machine ID");
  return machineId;
};

export interface DocumentMachineIdentityOptions {
  /** The operator's name for this machine, as `--machine-name` would give it. */
  readonly machineName?: string;
  /** The name when none is configured (the Node owner uses the host name). */
  readonly defaultName: string;
  readonly platform: RuntimeMachineIdentity["platform"];
}

/** Reads the machine identity, creating its ID on the first read; concurrent first reads agree. */
export async function readDocumentMachineIdentity(
  documents: StateDocumentStore,
  options: DocumentMachineIdentityOptions,
): Promise<RuntimeMachineIdentity> {
  const name = configuredMachineName(options.machineName) ?? options.defaultName;
  const machineId = await documents.update(MACHINE_IDENTITY_DOCUMENT, (current) => {
    if (current !== null) return { result: persistedMachineId(current) };
    const created = { machineId: crypto.randomUUID() };
    return { result: created.machineId, next: created };
  });
  return parseRuntimeMachineIdentity({ machineId, name, platform: options.platform });
}
