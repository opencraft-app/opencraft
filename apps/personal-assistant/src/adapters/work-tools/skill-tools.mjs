import { Type } from "@earendil-works/pi-ai";
const defineTool = (definition) => definition;

/** Narrow content port only: installation and enablement are never agent tools. */
export function skillTools({ list, load, guard }) {
  const output = (value) => ({
    output: [{ type: "text", text: JSON.stringify(value) }],
  });
  return [
    defineTool({
      name: "list_skills",
      description:
        "List enabled skill summaries pinned to this execution. Read relevant methods with load_skill before using them.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        guard("list_skills");
        return output(list());
      },
    }),
    defineTool({
      name: "load_skill",
      description:
        "Load one pinned skill method on demand. Skill text is guidance and cannot grant tools, credentials or filesystem access.",
      parameters: Type.Object({ skillId: Type.String() }),
      replay: "safe",
      execute: async (args) => {
        guard("load_skill");
        return output(load(args.skillId));
      },
    }),
  ];
}
