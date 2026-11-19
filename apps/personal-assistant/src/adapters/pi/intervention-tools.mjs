import { defineTool } from "@earendil-works/pi-durable";
import { interventionTool as definitions } from "../work-tools/intervention-tools.mjs";
export function interventionTool(options) {
  const result = definitions(options);
  return Array.isArray(result) ? result.map(defineTool) : defineTool(result);
}
