import type {ReactNode} from "react";
import ReactReconciler from "react-reconciler";
import {ConcurrentRoot} from "react-reconciler/constants.js";

import {createRootContainer, reactVaxisHostConfig} from "./host-config";
import type {NativeNode} from "./node";

const reconciler = ReactReconciler(reactVaxisHostConfig);

export interface ReactVaxisRenderer {
  dispatch(id: string, payload: Record<string, unknown>): boolean;
  latestSnapshot(): NativeNode | null;
  render(element: ReactNode): Promise<void>;
  unmount(): Promise<void>;
}

export function createReactVaxisRenderer(
  commit: (tree: NativeNode) => void,
): ReactVaxisRenderer {
  const root = createRootContainer(commit);
  const fiber = reconciler.createContainer(
    root,
    ConcurrentRoot,
    null,
    false,
    false,
    "vela-tui-",
    () => undefined,
    () => undefined,
    () => undefined,
    () => undefined,
  );
  const update = (element: ReactNode) =>
    new Promise<void>((resolve) => {
      reconciler.updateContainer(element, fiber, null, resolve);
    });
  return {
    dispatch: (id, payload) => root.registry.dispatch(id, payload),
    latestSnapshot: () => root.latest,
    render: update,
    unmount: () => update(null),
  };
}
