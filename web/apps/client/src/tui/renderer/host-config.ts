import {
  DefaultEventPriority,
  NoEventPriority,
} from "react-reconciler/constants.js";

import {
  appendChild,
  createHostInstance,
  createRawTextInstance,
  insertBefore,
  removeChild,
  replaceProps,
  replaceText,
  serializeRoot,
  type HostChild,
  type HostInstance,
  type HostType,
  type NativeNode,
  type RawTextInstance,
} from "./node";
import {HandlerRegistry} from "./registry";

export interface RootContainer {
  children: HostChild[];
  commit(tree: NativeNode): void;
  latest: NativeNode | null;
  registry: HandlerRegistry;
}

interface HostContext {
  insideText: boolean;
}

let currentUpdatePriority = NoEventPriority;

function append(parent: {children: HostChild[]}, child: HostChild): void {
  const current = parent.children.indexOf(child);
  if (current >= 0) parent.children.splice(current, 1);
  parent.children.push(child);
}

function insert(
  parent: {children: HostChild[]},
  child: HostChild,
  before: HostChild,
): void {
  const current = parent.children.indexOf(child);
  if (current >= 0) parent.children.splice(current, 1);
  const index = parent.children.indexOf(before);
  if (index < 0) throw new Error("ReactVaxis before-child is not mounted");
  parent.children.splice(index, 0, child);
}

function remove(parent: {children: HostChild[]}, child: HostChild): void {
  const index = parent.children.indexOf(child);
  if (index >= 0) parent.children.splice(index, 1);
}

export function createRootContainer(
  commit: (tree: NativeNode) => void,
): RootContainer {
  return {
    children: [],
    commit,
    latest: null,
    registry: new HandlerRegistry(),
  };
}

export const reactVaxisHostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  warnsIfNotActing: false,
  createInstance(type: HostType, props: Record<string, unknown>) {
    return createHostInstance(type, props);
  },
  createTextInstance(text: string, _root: RootContainer, context: HostContext) {
    if (!context.insideText) {
      throw new Error("Raw text must be nested under Text");
    }
    return createRawTextInstance(text);
  },
  appendInitialChild: appendChild,
  finalizeInitialChildren() {
    return false;
  },
  shouldSetTextContent() {
    return false;
  },
  getRootHostContext(): HostContext {
    return {insideText: false};
  },
  getChildHostContext(_context: HostContext, type: HostType): HostContext {
    return {insideText: type === "Text"};
  },
  getPublicInstance(instance: HostInstance) {
    return instance;
  },
  prepareForCommit() {
    return null;
  },
  resetAfterCommit(root: RootContainer) {
    root.registry.beginCommit();
    try {
      if (root.children.length === 0) {
        root.latest = null;
        return;
      }
      const snapshot = serializeRoot(root.children, root.registry);
      root.latest = snapshot;
      root.commit(snapshot);
    } finally {
      root.registry.endCommit();
    }
  },
  preparePortalMount() {},
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  supportsMicrotasks: true,
  scheduleMicrotask(callback: () => void) {
    void Promise.resolve().then(callback);
  },
  setCurrentUpdatePriority(priority: number) {
    currentUpdatePriority = priority;
  },
  getCurrentUpdatePriority() {
    return currentUpdatePriority;
  },
  resolveUpdatePriority() {
    return currentUpdatePriority || DefaultEventPriority;
  },
  trackSchedulerEvent() {},
  resolveEventType() {
    return null;
  },
  resolveEventTimeStamp() {
    return -1.1;
  },
  shouldAttemptEagerTransition() {
    return false;
  },
  getInstanceFromNode() {
    return null;
  },
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  prepareScopeUpdate() {},
  getInstanceFromScope() {
    return null;
  },
  detachDeletedInstance() {},
  appendChild,
  appendChildToContainer: append,
  insertBefore,
  insertInContainerBefore: insert,
  removeChild,
  removeChildFromContainer: remove,
  resetTextContent(instance: HostInstance) {
    instance.children = [];
  },
  commitTextUpdate(instance: RawTextInstance, _old: string, next: string) {
    replaceText(instance, next);
  },
  commitMount() {},
  commitUpdate(
    instance: HostInstance,
    _type: HostType,
    _previous: Record<string, unknown>,
    next: Record<string, unknown>,
  ) {
    replaceProps(instance, next);
  },
  hideInstance() {
    throw new Error("ReactVaxis does not support hidden host instances");
  },
  hideTextInstance() {
    throw new Error("ReactVaxis does not support hidden text instances");
  },
  unhideInstance() {
    throw new Error("ReactVaxis does not support hidden host instances");
  },
  unhideTextInstance() {
    throw new Error("ReactVaxis does not support hidden text instances");
  },
  clearContainer(root: RootContainer) {
    root.children = [];
  },
  maySuspendCommit() {
    return false;
  },
  preloadInstance() {
    return true;
  },
  startSuspendingCommit() {},
  suspendInstance() {},
  waitForCommitToBeReady() {
    return null;
  },
  NotPendingTransition: null,
  HostTransitionContext: {
    $$typeof: Symbol.for("react.context"),
    Consumer: null,
    Provider: null,
    _currentValue: null,
    _currentValue2: null,
    _threadCount: 0,
  },
  resetFormInstance() {},
  requestPostPaintCallback() {},
} as never;
