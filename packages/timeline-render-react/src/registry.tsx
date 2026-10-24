import { Context, Service } from "@deepseek-ai/cordis";
import type { TimelineBlock } from "@opencraft/chat-core";
import {
  createContext,
  createElement,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";

export interface TimelineBlockRendererProps {
  readonly block: TimelineBlock;
  readonly onRetry?: () => void;
  readonly richText: boolean;
}

export interface TimelineBlockRendererRegistration {
  readonly name: string;
  readonly priority: number;
  readonly types: readonly TimelineBlock["type"][];
  readonly component: ComponentType<TimelineBlockRendererProps>;
  readonly matches?: (block: TimelineBlock) => boolean;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    timelineBlockRenderers: TimelineBlockRendererRegistryService;
  }
}

export class TimelineBlockRendererRegistryService extends Service {
  private readonly registrations = new Map<string, TimelineBlockRendererRegistration>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly TimelineBlockRendererRegistration[] = [];

  constructor(ctx: Context) {
    super(ctx, "timelineBlockRenderers");
    ctx.effect(() => () => {
      this.registrations.clear();
      this.publish();
    });
  }

  register(registration: TimelineBlockRendererRegistration): () => void {
    if (registration.name.trim().length === 0) throw new RangeError("Timeline renderer name must not be empty");
    if (registration.types.length === 0) throw new RangeError(`Timeline renderer ${registration.name} must declare a block type`);
    if (this.registrations.has(registration.name)) throw new Error(`Timeline renderer ${registration.name} already exists`);
    this.registrations.set(registration.name, registration);
    this.publish();
    return () => {
      if (this.registrations.get(registration.name) !== registration) return;
      this.registrations.delete(registration.name);
      this.publish();
    };
  }

  resolve(
    snapshot: readonly TimelineBlockRendererRegistration[],
    block: TimelineBlock,
  ): TimelineBlockRendererRegistration | null {
    return snapshot.find((registration) =>
      registration.types.includes(block.type)
      && (registration.matches?.(block) ?? true)
    ) ?? null;
  }

  getSnapshot = (): readonly TimelineBlockRendererRegistration[] => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(): void {
    this.snapshot = [...this.registrations.values()].sort(
      (left, right) => right.priority - left.priority,
    );
    for (const listener of this.listeners) listener();
  }
}

interface TimelineBlockRendererContextValue {
  readonly registry: TimelineBlockRendererRegistryService;
  readonly snapshot: readonly TimelineBlockRendererRegistration[];
}

const TimelineBlockRendererContext = createContext<TimelineBlockRendererContextValue | null>(null);

export function TimelineBlockRendererProvider({
  children,
  registry,
}: {
  readonly children: ReactNode;
  readonly registry: TimelineBlockRendererRegistryService;
}) {
  // One application listener owns registry publication. Thousands of mounted
  // TimelineBlockView rows must not each subscribe to the same rare event.
  const snapshot = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  );
  const value = useMemo(() => ({ registry, snapshot }), [registry, snapshot]);
  return createElement(TimelineBlockRendererContext.Provider, { value }, children);
}

export function TimelineBlockView(props: TimelineBlockRendererProps) {
  const context = useContext(TimelineBlockRendererContext);
  if (context === null) throw new Error("TimelineBlockRendererProvider is missing");
  const registration = context.registry.resolve(context.snapshot, props.block);
  if (registration === null) return null;
  return createElement(registration.component, props);
}
