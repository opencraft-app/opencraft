// Trusted distribution composition, not a model-visible plugin API.
let extension, composed = false;
const FUNCTIONS = ["request", "reportFailure", "createRuntime"];

/** Rejects anything that is not an Assistant Host extension before installation. */
export function validateAssistantHostExtension(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid Assistant Host extension: expected an object");
  for (const [key, member] of Object.entries(value)) {
    if (key === "entryURL") {
      if (member === undefined) continue;
      const url = member instanceof URL ? member : typeof member === "string" && URL.canParse(member) ? new URL(member) : null;
      if (url?.protocol !== "file:") throw Error("Invalid Assistant Host extension: entryURL must be a file URL");
    } else if (!FUNCTIONS.includes(key)) throw Error(`Invalid Assistant Host extension: unknown member ${key}`);
    else if (member !== undefined && typeof member !== "function")
      throw Error(`Invalid Assistant Host extension: ${key} must be a function`);
  }
}

/** Import-time installation, kept for existing entries. Reinstalling the same
 * value is a no-op; it never replaces a different or composition-owned extension. */
export function installAssistantHostExtension(value) {
  if (composed) throw Error("Assistant Host extension already installed by server composition");
  if (extension && extension !== value) throw Error("Assistant Host extension already installed");
  extension = value;
}

/** Server composition installation: exclusive for one server lifetime. Returns
 * the release used after that server has closed. */
export function claimAssistantHostExtension(value) {
  validateAssistantHostExtension(value);
  if (extension)
    throw Error(
      extension === value
        ? "Assistant Host extension already installed; install it once, either through server composition or by import"
        : "A different Assistant Host extension is already installed",
    );
  extension = value;
  composed = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (extension === value && composed) {
      extension = undefined;
      composed = false;
    }
  };
}
export const assistantHostExtension = () => extension;
