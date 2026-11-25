import type { StateDocumentStore } from "@opencraft/document-storage/state";
import { validateModelDocument } from "@opencraft/local-agent-host/model-config/document";
import { MODEL_DOCUMENT_KEY } from "@opencraft/local-agent-host/model-config/repository";
import { validateSecretName, validateSecretValue } from "@opencraft/secret-storage";
import type { AccountAssembly } from "../assembly/account.mjs";

/** Initialize the existing repositories under AccountCore's startup fence. */
export async function bootstrapAccountModels(
  raw: string,
  documents: StateDocumentStore,
  { modelConfiguration, modelCredentials }: Pick<AccountAssembly, "modelConfiguration" | "modelCredentials">,
) {
  if ((await documents.read(MODEL_DOCUMENT_KEY)) !== null) return;
  let seed: unknown;
  try {
    seed = JSON.parse(raw);
  } catch {
    // Syntax error messages can contain snippets of the operator's secret.
    throw new Error("Invalid AccountCore model bootstrap JSON");
  }
  if (
    !seed ||
    typeof seed !== "object" ||
    !("document" in seed) ||
    Object.keys(seed).some((key) => key !== "document" && key !== "credentials")
  ) {
    throw new Error("Invalid AccountCore model bootstrap");
  }
  const document = seed.document;
  validateModelDocument(document);
  if (document.revision !== 0) throw new Error("Model bootstrap must start at revision 0");
  const credentials = "credentials" in seed ? seed.credentials : {};
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    throw new Error("Invalid AccountCore bootstrap credentials");
  }
  const refs = new Set(document.providers.map((provider) => provider.credentialRef));
  const missing = new Map<string, string>();
  for (const [ref, value] of Object.entries(credentials as Record<string, unknown>)) {
    validateSecretName(ref);
    validateSecretValue(value);
    if (!refs.has(ref)) throw new Error("Bootstrap credential is not referenced by a provider");
    const current = await modelCredentials.resolve(ref);
    if (current === undefined) missing.set(ref, value);
    else if (current !== value) throw new Error("Bootstrap conflicts with a stored credential");
  }
  // The model document is the commit point. A restart can finish a partially
  // staged seed with the same values and never rewrites the live document.
  for (const [ref, value] of missing) await modelCredentials.set(ref, value);
  await modelConfiguration.initialize(document);
}
