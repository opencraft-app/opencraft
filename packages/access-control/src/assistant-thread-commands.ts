import type { AgentDriverContract } from "@opencraft/appserver-client";
import type { Collaboration } from "./collaboration.js";
import type { ThreadAccessStore } from "./thread-access.js";
import { ThreadOrchestrationBroker } from "./thread-orchestration-broker.js";
/** Legacy desktop/test constructor. All Thread commands execute in the shared Broker. */
export class AssistantThreadCommands extends ThreadOrchestrationBroker {
  constructor(service: Collaboration, execution: AgentDriverContract, access: ThreadAccessStore) {
    super(service, execution);
    this.enableAssistantThreads(access);
  }
  initialize() {
    return this.initializeAssistantThreads();
  }
}
