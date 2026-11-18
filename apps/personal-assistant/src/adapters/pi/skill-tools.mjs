import { defineTool } from "@earendil-works/pi-durable";
import { skillTools as definitions } from "../work-tools/skill-tools.mjs";
export function skillTools(options) {
  const result = definitions(options);
  return Array.isArray(result) ? result.map(defineTool) : defineTool(result);
}
