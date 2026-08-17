import {HandlerRegistry} from "./registry";

export type HostType =
  | "Button"
  | "Checkbox"
  | "NavigationStack"
  | "Overlay"
  | "ScrollView"
  | "Segmented"
  | "Text"
  | "TextInput"
  | "View"
  | "VirtualList";

export interface NativeStyle {
  border?: boolean;
  crossAlign?: string;
  direction?: string;
  flex?: number;
  gap?: number;
  height?: number;
  mainAlign?: string;
  maxHeight?: number;
  maxWidth?: number;
  minHeight?: number;
  minWidth?: number;
  paddingX?: number;
  paddingY?: number;
  surface?: string;
  width?: number;
}

export interface NativeNode {
  activeIndex?: number;
  activeRouteKey?: string;
  alignment?: string;
  autoFocus?: boolean;
  canGoBack?: boolean;
  checked?: boolean;
  children?: NativeNode[];
  contentStyle?: NativeStyle;
  disabled?: boolean;
  estimatedItemExtent?: number;
  groupValue?: string;
  itemExtent?: number;
  label?: string;
  layoutVersion?: string;
  maxLines?: number;
  modal?: boolean;
  mostRecentEventCount?: number;
  onBack?: string;
  onChangeText?: string;
  onDismiss?: string;
  onPress?: string;
  onValueChange?: string;
  overscan?: number;
  placeholder?: string;
  progress?: number;
  secureTextEntry?: boolean;
  segments?: Array<{disabled?: boolean; label: string; value: string}>;
  selected?: boolean;
  style?: NativeStyle;
  subtitle?: string;
  testId?: string;
  text?: string;
  title?: string;
  trailing?: string;
  type: HostType;
  value?: string;
  width?: number;
}

export interface HostInstance {
  children: HostChild[];
  props: Record<string, unknown>;
  type: HostType;
}

export interface RawTextInstance {
  text: string;
  type: "RawText";
}

export type HostChild = HostInstance | RawTextInstance;

const scalarProps = [
  "activeIndex",
  "activeRouteKey",
  "alignment",
  "autoFocus",
  "canGoBack",
  "checked",
  "disabled",
  "estimatedItemExtent",
  "groupValue",
  "itemExtent",
  "label",
  "layoutVersion",
  "maxLines",
  "modal",
  "mostRecentEventCount",
  "overscan",
  "placeholder",
  "progress",
  "secureTextEntry",
  "selected",
  "subtitle",
  "title",
  "trailing",
  "value",
  "width",
] as const;

const eventProps = [
  "onBack",
  "onChangeText",
  "onDismiss",
  "onPress",
  "onValueChange",
] as const;

const styleProps = new Set<keyof NativeStyle>([
  "border",
  "crossAlign",
  "direction",
  "flex",
  "gap",
  "height",
  "mainAlign",
  "maxHeight",
  "maxWidth",
  "minHeight",
  "minWidth",
  "paddingX",
  "paddingY",
  "surface",
  "width",
]);

export function createHostInstance(
  type: HostType,
  props: Record<string, unknown>,
): HostInstance {
  return {children: [], props: {...props}, type};
}

export function createRawTextInstance(text: string): RawTextInstance {
  return {text, type: "RawText"};
}

export function appendChild(parent: HostInstance, child: HostChild): void {
  parent.children.push(child);
}

export function insertBefore(
  parent: HostInstance,
  child: HostChild,
  before: HostChild,
): void {
  const index = parent.children.indexOf(before);
  if (index < 0) throw new Error("ReactVaxis before-child is not mounted");
  parent.children.splice(index, 0, child);
}

export function removeChild(parent: HostInstance, child: HostChild): void {
  const index = parent.children.indexOf(child);
  if (index >= 0) parent.children.splice(index, 1);
}

export function replaceProps(
  instance: HostInstance,
  props: Record<string, unknown>,
): void {
  instance.props = {...props};
}

export function replaceText(instance: RawTextInstance, text: string): void {
  instance.text = text;
}

export function serializeRoot(
  children: HostChild[],
  registry: HandlerRegistry,
): NativeNode {
  const root = children[0];
  if (children.length !== 1 || !root || root.type === "RawText") {
    throw new Error("ReactVaxis root requires exactly one host node");
  }
  return serializeHost(root, registry);
}

function serializeHost(
  instance: HostInstance,
  registry: HandlerRegistry,
): NativeNode {
  const node: NativeNode = {type: instance.type};
  if (typeof instance.props.testID === "string") {
    node.testId = instance.props.testID;
  }
  for (const property of scalarProps) {
    const value = instance.props[property];
    if (value !== undefined && value !== null) {
      Object.assign(node, {[property]: value});
    }
  }
  for (const property of eventProps) {
    const callback = instance.props[property];
    if (typeof callback === "function") {
      Object.assign(node, {
        [property]: registry.bind(
          instance,
          property,
          callback as (payload: Record<string, unknown>) => unknown,
        ),
      });
    }
  }
  const style = nativeStyle(instance.props.style);
  if (style) node.style = style;
  const contentStyle = nativeStyle(instance.props.contentStyle);
  if (contentStyle) node.contentStyle = contentStyle;
  if (Array.isArray(instance.props.segments)) {
    node.segments = instance.props.segments.map((segment) => ({
      ...(segment && typeof segment === "object" ? segment : {}),
    })) as NativeNode["segments"];
  }

  const children: NativeNode[] = [];
  let text = "";
  for (const child of instance.children) {
    if (child.type === "RawText") {
      if (instance.type !== "Text") {
        throw new Error("Raw text must be nested under Text");
      }
      text += child.text;
      continue;
    }
    children.push(serializeHost(child, registry));
  }
  if (text) node.text = text;
  if (children.length > 0) node.children = children;
  return node;
}

function nativeStyle(value: unknown): NativeStyle | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result: NativeStyle = {};
  for (const [property, item] of Object.entries(value)) {
    if (!styleProps.has(property as keyof NativeStyle)) continue;
    if (
      typeof item === "boolean" ||
      typeof item === "number" ||
      typeof item === "string"
    ) {
      Object.assign(result, {[property]: item});
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
