import { ReceptionQueryGrant } from "../domain/reception-query.mjs";
import { Delegation, delegationTools } from "../domain/assistant.mjs";

/** Scope comes from authenticated local composition, never a model proposal. */
export class ScopePolicy {
  constructor(assistant, resources = [], memoryResources = () => []) {
    this.assistant = assistant;
    this.baseResources = structuredClone(resources);
    this.memoryResources = memoryResources;
  }
  set resources(value) {
    this.baseResources = structuredClone(value).filter((r) => !r.id.startsWith("memory.project/"));
  }
  get resources() {
    return [...structuredClone(this.baseResources), ...this.memoryResources()];
  }
  queryGrant(inputId, conversationId) {
    return ReceptionQueryGrant.create(this.assistant, conversationId, inputId, this.resources);
  }
  reportGrant(inputId, conversationId, work) {
    return ReceptionQueryGrant.create(this.assistant, conversationId, inputId, this.forWork(work).record.resources);
  }
  receptionResources(turn, conversationId) {
    return this.queryScope(turn, conversationId).resources;
  }
  queryScope(turn, conversationId) {
    return ReceptionQueryGrant.forTurn(turn, this.assistant, conversationId);
  }
  querySourceAllowed(grant, resource) {
    return (
      !!resource &&
      grant.resources.some((r) => r.id === resource.id && r.binding === resource.binding) &&
      this.resources.some((r) => r.id === resource.id && r.binding === resource.binding)
    );
  }
  canObserve(resources) {
    return resources.some(
      (r) =>
        r.id === "materials" && this.resources.some((current) => current.id === r.id && current.binding === r.binding),
    );
  }
  delegate(inputId, resources = this.resources) {
    if (resources.some((r) => !this.resources.some((current) => r.id === current.id && r.binding === current.binding)))
      throw new Error("Captured resource binding changed before delegation");
    return new Delegation({
      assistantId: this.assistant.id,
      actor: this.assistant.owner,
      inputId,
      tools: delegationTools(resources),
      resources,
    }).toJSON();
  }
  forWork(work, inputId = "legacy") {
    // Phase-1 work never inherits newly added file access merely by reopening under new config.
    return new Delegation(
      work.delegation_json
        ? JSON.parse(work.delegation_json)
        : {
            assistantId: this.assistant.id,
            actor: this.assistant.owner,
            inputId,
            tools: ["work_context", "publish_note"],
            resources: [],
          },
    );
  }
  check(work, tool, resource) {
    const delegation = this.forWork(work);
    if (delegation.record.assistantId !== this.assistant.id || delegation.record.actor !== this.assistant.owner)
      throw new Error("Work delegation belongs to another assistant or owner");
    delegation.permits(tool, resource);
    if (resource && !this.resources.some((r) => r.id === resource.id && r.binding === resource.binding))
      throw new Error("Configured resource binding changed");
  }
}
