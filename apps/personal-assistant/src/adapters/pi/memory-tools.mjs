import { defineTool } from "@earendil-works/pi-durable";
import { memoryTools as definitions } from "../work-tools/memory-tools.mjs";
export function memoryTools(options) {
  const result = definitions(options);
  return Array.isArray(result) ? result.map(defineTool) : defineTool(result);
}
