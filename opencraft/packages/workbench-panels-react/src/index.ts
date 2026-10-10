import { Context, Service, type Fiber, type Plugin } from "@deepseek-ai/cordis";
import {
  WorkbenchPanelService,
  type PanelTabDescriptor,
  type WorkbenchPanelServiceConfig,
} from "@opencraft/workbench-panels";
import type { ComponentType } from "react";

export interface PanelRendererProps {
  readonly tab: PanelTabDescriptor;
  /** Stable Conversation owner of panel state and logical resources. */
  readonly ownerId: string;
  /** Ephemeral Route/View surface presenting the stable panel state. */
  readonly presentationId: string;
  /** Logical visibility, not exit-animation progress. Inactive cannot own input. */
  readonly active?: boolean;
}

export interface PanelRendererRegistration {
  readonly kind: string;
  readonly Component: ComponentType<PanelRendererProps>;
  /** Opt-in only: preserve the physical viewer while its tab remains open. */
  readonly residency?: "while-tab-open";
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    workbenchPanelRenderers: WorkbenchPanelRendererRegistryService;
  }
}

export class WorkbenchPanelRendererRegistryService extends Service {
  private readonly renderers = new Map<string, PanelRendererRegistration>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly PanelRendererRegistration[] = [];

  constructor(ctx: Context) {
    super(ctx, "workbenchPanelRenderers");
    ctx.effect(() => () => {
      this.renderers.clear();
      this.publish();
    });
  }

  register(registration: PanelRendererRegistration): () => void {
    if (registration.kind.trim().length === 0) throw new RangeError("Panel renderer kind must not be empty");
    if (this.renderers.has(registration.kind)) throw new Error(`Panel renderer ${registration.kind} is already registered`);
    this.renderers.set(registration.kind, registration);
    this.publish();
    return () => {
      if (this.renderers.get(registration.kind) !== registration) return;
      this.renderers.delete(registration.kind);
      this.publish();
    };
  }

  resolve(snapshot: readonly PanelRendererRegistration[], kind: string) {
    return snapshot.find((registration) => registration.kind === kind)?.Component ?? null;
  }

  getSnapshot = (): readonly PanelRendererRegistration[] => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(): void {
    this.snapshot = [...this.renderers.values()];
    for (const listener of this.listeners) listener();
  }
}

export interface WorkbenchPanelReactRuntime {
  readonly context: Context;
  readonly panels: WorkbenchPanelService;
  readonly renderers: WorkbenchPanelRendererRegistryService;
  install(plugin: Plugin, config?: unknown): Promise<Fiber>;
  dispose(): Promise<void>;
}

export async function createWorkbenchPanelReactRuntime(
  config: WorkbenchPanelServiceConfig = {},
  context: Context = new Context(),
): Promise<WorkbenchPanelReactRuntime> {
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
    if (failures.length > 0) throw new AggregateError(failures, "Failed to dispose Workbench Panel runtime");
  };
  const install = async (plugin: Plugin, pluginConfig?: unknown) => {
    const fiber = pluginConfig === undefined
      ? context.plugin(plugin)
      : context.plugin(plugin, pluginConfig);
    fibers.push(fiber);
    await fiber;
    return fiber;
  };
  try {
    await install(WorkbenchPanelService, config);
    await install(WorkbenchPanelRendererRegistryService);
  } catch (error) {
    await disposeFibers().catch(() => undefined);
    throw error;
  }
  return {
    context,
    panels: context.workbenchPanels,
    renderers: context.workbenchPanelRenderers,
    install,
    async dispose() {
      await disposeFibers();
    },
  };
}
