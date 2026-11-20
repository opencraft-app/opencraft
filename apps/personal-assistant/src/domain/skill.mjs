import { digest, requireText } from "./values.mjs";

export function skillDefinition(raw, pluginId = "local") {
  if (typeof raw?.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(raw.id))
    throw new Error("Skill id must be a lowercase name");
  if (typeof pluginId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(pluginId))
    throw new Error("Invalid plugin id");
  const summary = requireText(raw.summary, "skill summary", 500);
  const body = requireText(raw.body, "skill body", 32000);
  const id = `${pluginId}/${raw.id}`;
  return {
    id,
    pluginId,
    summary,
    body,
    version: digest({ id, summary, body }),
  };
}
