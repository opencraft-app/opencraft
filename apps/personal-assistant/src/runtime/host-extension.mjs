// Trusted distribution composition, not a model-visible plugin API.
let extension;
export function installAssistantHostExtension(value) {
  if (extension && extension !== value) throw Error("Assistant Host extension already installed");
  extension = value;
}
export const assistantHostExtension = () => extension;
