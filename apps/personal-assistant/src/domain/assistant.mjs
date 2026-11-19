import { botBinding } from "./bot-binding.mjs";
import { requireText, stable } from "./values.mjs";

/** Stable business identity; model, process and native Session identities are separate. */
export class Assistant {
  constructor({ assistantId, owner, botBinding: binding }) {
    this.id = requireText(assistantId, "assistantId", 160);
    this.owner = requireText(owner, "owner", 160);
    if (binding) this.botBinding = botBinding(binding);
  }
  identity() {
    return {
      assistantId: this.id,
      owner: this.owner,
      ...(this.botBinding ? { botBinding: this.botBinding } : {}),
    };
  }
  verifyPersisted(identity) {
    if (stable(identity) !== stable(this.identity())) throw new Error("Profile identity differs from persisted owner");
  }
}

/** An immutable delegation records existing scope; the model cannot manufacture new grants. */
export class Delegation {
  #record;
  constructor(record) {
    this.#record = structuredClone(record);
    if (
      !record.actor ||
      !record.assistantId ||
      !record.inputId ||
      !Array.isArray(record.tools) ||
      !Array.isArray(record.resources)
    )
      throw new Error("Invalid delegation");
  }
  permits(tool, resource) {
    if (!this.#record.tools.includes(tool)) throw new Error(`Delegation does not permit ${tool}`);
    if (resource && !this.#record.resources.some((r) => r.id === resource.id && r.binding === resource.binding))
      throw new Error("Resource binding is outside the original delegation");
  }
  get record() {
    return this.toJSON();
  }
  toJSON() {
    return structuredClone(this.#record);
  }
}

/** Project tools from already captured resources. This does not grant authority. */
export function delegationTools(resources = []) {
  return [
    "work_context",
    ...(resources.some((r) => r.id === "platform.reads") ? ["platform_read"] : []),
    ...(resources.some((r) => r.id === "platform.threads") ? ["thread_command"] : []),
    ...(resources.some((r) => r.id === "execution.environment") ? ["environment_run"] : []),
    "recall_memory",
    "read_memory_file",
    "list_memory_files",
    "search_history",
    "publish_note",
    "ask_user",
    "request_intervention",
    "list_skills",
    "load_skill",
    ...(resources.some((r) => r.id === "materials") ? ["list_materials", "read_material"] : []),
  ];
}
