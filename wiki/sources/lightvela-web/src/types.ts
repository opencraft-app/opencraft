export type Attributes = Record<string, string>;

export interface RichNode {
  tag: string;
  attrs: Attributes;
  text?: string;
  children?: RichNode[];
}

export interface ImageContent {
  src: string;
  alt: string;
  originalSrc?: string;
}

export interface VideoContent {
  src: string;
  poster: string;
  title: string;
  duration: number;
}

export interface DynamicContent {
  pageIndex: number;
  title: string;
}

export type Content = RichNode | ImageContent | VideoContent | DynamicContent;
export type ContentMap = Record<string, Content>;

export interface SlideElement {
  key: string;
  type: string;
  attrs: Attributes;
  contentKey?: string;
}

export interface SlidePage {
  id: string;
  number: number;
  title: string;
  section: string;
  elements: SlideElement[];
}

export interface SupplementPage extends SlidePage {
  group: string;
  label: string;
}

export interface Theme {
  colors: Record<string, string>;
  fonts: Record<string, { family: string; size: number }>;
  size: { width: number; height: number };
}
