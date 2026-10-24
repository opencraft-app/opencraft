import { Context, type Fiber, type Plugin } from "@deepseek-ai/cordis";

import { ChatDirectiveRegistryService } from "./services/directive-registry-service";
import {
  ChatDocumentCompilerService,
  type ChatDocumentCompilerServiceConfig,
} from "./services/document-compiler-service";
import { ChatNodeRendererRegistryService } from "./services/renderer-registry-service";
import { ChatResourcePolicyService } from "./services/resource-policy-service";

export interface ChatRenderRuntime {
  readonly context: Context;
  readonly documents: ChatDocumentCompilerService;
  readonly renderers: ChatNodeRendererRegistryService;
  readonly directives: ChatDirectiveRegistryService;
  readonly resources: ChatResourcePolicyService;
  install(plugin: Plugin, config?: unknown): Promise<Fiber>;
  dispose(): Promise<void>;
}

export async function createChatRenderRuntime(
  config: ChatDocumentCompilerServiceConfig = {},
  context: Context = new Context(),
): Promise<ChatRenderRuntime> {
  const fibers: Fiber[] = [];
  const disposeFibers = async () => {
    const failures: unknown[] = [];
    for (const fiber of fibers.splice(0).reverse()) {
      try {
        await fiber.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to dispose Chat Render runtime");
    }
  };
  const installService = async <TConfig>(
    plugin: new (ctx: Context, config: TConfig) => unknown,
    pluginConfig: TConfig,
  ) => {
    const fiber = context.plugin(plugin, pluginConfig);
    fibers.push(fiber);
    await fiber;
  };
  const installEmpty = async (plugin: new (ctx: Context) => unknown) => {
    const fiber = context.plugin(plugin);
    fibers.push(fiber);
    await fiber;
  };

  try {
    await installService(ChatDocumentCompilerService, config);
    await installEmpty(ChatNodeRendererRegistryService);
    await installEmpty(ChatDirectiveRegistryService);
    await installEmpty(ChatResourcePolicyService);
  } catch (error) {
    await disposeFibers().catch(() => undefined);
    throw error;
  }

  return {
    context,
    documents: context.chatDocumentCompiler,
    renderers: context.chatNodeRenderers,
    directives: context.chatDirectives,
    resources: context.chatResourcePolicies,
    async install(plugin, pluginConfig) {
      const fiber = pluginConfig === undefined
        ? context.plugin(plugin)
        : context.plugin(plugin, pluginConfig);
      fibers.push(fiber);
      await fiber;
      return fiber;
    },
    async dispose() {
      await disposeFibers();
    },
  };
}
