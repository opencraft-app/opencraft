import { memoryScenario } from "./memory.mjs";
import { workScenario } from "./work.mjs";
import { automationsScenario } from "./automations.mjs";
import { skillsScenario } from "./skills.mjs";

export const scenarioCatalog = Object.freeze(
  [
    {
      id: "memory",
      run: memoryScenario,
      review:
        "Check explicit correction/forget and automatic fact fidelity against original user evidence; cross-key semantic forgetting remains unverified.",
    },
    {
      id: "work",
      run: workScenario,
      review:
        "Check question relevance, source fidelity, useful output and parent result wording. Restart/limits assertions alone do not prove quality.",
    },
    {
      id: "automations",
      run: automationsScenario,
      review:
        "Check interval intent and actual local event result/notification. This does not cover calendar understanding, remote events or human read receipts.",
    },
    {
      id: "skills",
      run: skillsScenario,
      review:
        "Check whether the loaded method improved source-grounded content. Explicit loading is not autonomous skill selection.",
    },
  ].map(Object.freeze),
);

/** Validate before creating directories or touching provider configuration. */
export function selectScenarios(names) {
  if (names === undefined) return [...scenarioCatalog];
  if (
    !Array.isArray(names) ||
    !names.length ||
    new Set(names).size !== names.length
  )
    throw new Error("Scenarios must be a nonempty list without duplicates");
  return names.map((id) => {
    const scenario = scenarioCatalog.find((s) => s.id === id);
    if (!scenario)
      throw new Error(
        `Unknown scenario ${String(id)}; choose memory,work,automations,skills`,
      );
    return scenario;
  });
}
