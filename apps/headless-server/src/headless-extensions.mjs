import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  claimCommunicationExtension,
  communicationExtension,
  validateCommunicationExtension,
} from "@opencraft/access-control/communication-extension";
import {
  assistantHostExtension,
  claimAssistantHostExtension,
  validateAssistantHostExtension,
} from "@opencraft/personal-assistant/runtime/host-extension";

/**
 * Trusted server extensions selected by startup composition, in installation
 * order. Each module is operator-owned code, never a path from client input or
 * private JSON. A storage Worker re-imports the communication module by URL, so
 * every module is named by an absolute file location and one named export.
 */
const KINDS = Object.freeze([
  Object.freeze({
    kind: "communication",
    exportName: "communicationExtension",
    validate: validateCommunicationExtension,
    installed: communicationExtension,
    claim: (value, url) => claimCommunicationExtension(value, url),
  }),
  Object.freeze({
    kind: "assistantHost",
    exportName: "assistantHostExtension",
    validate: validateAssistantHostExtension,
    installed: assistantHostExtension,
    claim: (value) => claimAssistantHostExtension(value),
  }),
]);
const plain = (value) =>
  !!value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function moduleURL(kind, module) {
  const invalid = () => new Error(`Invalid Headless ${kind} extension module: expected a file URL or an absolute path`);
  if (module instanceof URL) {
    if (module.protocol !== "file:") throw invalid();
    return module.href;
  }
  if (typeof module !== "string" || !module) throw invalid();
  if (module.startsWith("file:")) {
    if (!URL.canParse(module)) throw invalid();
    return new URL(module).href;
  }
  if (!isAbsolute(module)) throw invalid();
  return pathToFileURL(module).href;
}

/** Shape check only: no import and no installation. Absent means no extensions. */
export function validateHeadlessExtensions(value) {
  if (value === undefined) return Object.freeze([]);
  if (!plain(value)) throw new Error("Invalid Headless extensions: expected an object");
  for (const key of Object.keys(value))
    if (!KINDS.some((entry) => entry.kind === key))
      throw new Error(`Invalid Headless extensions: unknown extension ${key}`);
  const selected = [];
  for (const { kind } of KINDS) {
    const entry = value[kind];
    if (entry === undefined) continue;
    if (!plain(entry) || Object.keys(entry).some((key) => key !== "module"))
      throw new Error(`Invalid Headless ${kind} extension: expected { module }`);
    selected.push(Object.freeze({ kind, url: moduleURL(kind, entry.module) }));
  }
  return Object.freeze(selected);
}

/** Imports and validates every selected module before startup creates resources.
 * Fails early when an extension of the same kind is already installed. */
export async function loadHeadlessExtensions(selected) {
  const loaded = [];
  for (const { kind, url } of selected) {
    const owner = KINDS.find((entry) => entry.kind === kind);
    let namespace;
    try {
      namespace = await import(url);
    } catch (cause) {
      throw new Error(`Could not load Headless ${kind} extension module ${url}`, { cause });
    }
    if (!Object.hasOwn(namespace, owner.exportName))
      throw new Error(`Headless ${kind} extension module ${url} does not export ${owner.exportName}`);
    const value = namespace[owner.exportName];
    owner.validate(value);
    if (owner.installed() !== undefined)
      throw new Error(
        owner.installed() === value
          ? `Headless ${kind} extension is already installed; install it once, either through server composition or by import`
          : `A different Headless ${kind} extension is already installed`,
      );
    loaded.push(Object.freeze({ kind, url, value }));
  }
  return Object.freeze(loaded);
}

/** Installs in declaration order; a conflict releases the ones already installed.
 * The returned release is idempotent and runs in reverse order. */
export function installHeadlessExtensions(loaded) {
  const releases = [];
  const release = () => {
    while (releases.length) releases.pop()();
  };
  try {
    for (const { kind, url, value } of loaded)
      releases.push(KINDS.find((entry) => entry.kind === kind).claim(value, url));
  } catch (error) {
    release();
    throw error;
  }
  return release;
}
