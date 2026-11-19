import {
  BROWSER_ANNOTATION_STYLE_PROPERTIES,
  type BrowserAnnotation,
  type BrowserAnnotationAnchor,
} from "@opencraft/browser-core";

/** Data URL bytes, including its header (ASCII); decoded bytes are bounded too. */
export const BROWSER_ANNOTATION_SCREENSHOT_LIMIT = 300 * 1024;
export const BROWSER_ANNOTATION_DRAFT_LIMIT = 8;
export const BROWSER_ANNOTATION_SELECTION_LIMIT = 8;
export const BROWSER_ANNOTATION_DRAFT_SELECTION_LIMIT = 32;
export const BROWSER_ANNOTATION_IMAGE_LIMIT = 4;
export const BROWSER_ANNOTATION_DRAFT_IMAGE_LIMIT = 8;
/** Reserve one MiB of the four MiB draft record for other Composer content. */
export const BROWSER_ANNOTATION_DRAFT_BYTES_LIMIT = 3 * 1024 * 1024;
export const BROWSER_ANNOTATION_SELECTED_TEXT_LIMIT = 2000;

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const encoder = new TextEncoder();

/** Copy data properties only: no getters, custom prototypes, cycles or toJSON. */
export function annotationData(value: unknown): unknown {
  let remaining = BROWSER_ANNOTATION_DRAFT_BYTES_LIMIT,
    nodes = 12000;
  const ancestors = new Set<object>();
  function copy(item: unknown, depth: number): unknown {
    if (--nodes < 0 || depth > 20) throw new Error("Annotation data is too complex");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string") {
      if (item.length > remaining || (remaining -= encoder.encode(item).length) < 0)
        throw new Error("Annotation data is too large");
      return item;
    }
    if (typeof item !== "object" || item === null || ancestors.has(item)) throw new Error("Invalid annotation data");
    const array = Array.isArray(item);
    if (
      Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype) &&
      Object.getPrototypeOf(item) !== null
    )
      throw new Error("Invalid annotation prototype");
    ancestors.add(item);
    const result: Record<string, unknown> | unknown[] = array ? [] : {};
    if (array && item.length > 256) throw new Error("Annotation array is too large");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.keys(descriptors).length > 256) throw new Error("Annotation object is too large");
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === "length") continue;
      if (forbidden.has(key) || !("value" in descriptor) || (array && !/^(0|[1-9]\d*)$/.test(key)))
        throw new Error("Invalid annotation property");
      // Optional TypeScript properties may be explicitly undefined before storage.
      if (descriptor.value === undefined && !array) continue;
      remaining -= encoder.encode(key).length + 4;
      if (remaining < 0) throw new Error("Annotation data is too large");
      (result as Record<string, unknown>)[key] = copy(descriptor.value, depth + 1);
    }
    if (array && ((result as unknown[]).length !== item.length || Object.keys(descriptors).length !== item.length + 1))
      throw new Error("Sparse annotation array");
    ancestors.delete(item);
    return result;
  }
  try {
    const result = copy(value, 0);
    // Escaping controls and metadata overhead can exceed the raw string budget.
    return encoder.encode(JSON.stringify(result)).length <= BROWSER_ANNOTATION_DRAFT_BYTES_LIMIT ? result : null;
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown, max = 2048): value is string {
  return typeof value === "string" && value.length <= max;
}
function nullable(value: unknown, max = 2048): boolean {
  return value === null || string(value, max);
}
function integer(value: unknown, max = 1e9): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function id(value: unknown): value is string {
  return string(value, 100) && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
}
function rect(value: unknown): boolean {
  return (
    record(value) &&
    [value.x, value.y, value.width, value.height].every(
      (n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1e9,
    ) &&
    value.width >= 0 &&
    value.height >= 0
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function validAnnotationImage(value: unknown): value is string {
  if (!string(value, BROWSER_ANNOTATION_SCREENSHOT_LIMIT)) return false;
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1]!.length % 4 !== 0) return false;
  return (
    (match[1]!.length / 4) * 3 - (match[1]!.endsWith("==") ? 2 : match[1]!.endsWith("=") ? 1 : 0) <=
    BROWSER_ANNOTATION_SCREENSHOT_LIMIT
  );
}
function validAnchor(a: unknown): a is BrowserAnnotationAnchor {
  if (
    !record(a) ||
    !["element", "region", "text"].includes(a.kind) ||
    !["main", "child"].includes(a.frame) ||
    ![a.url, a.title, a.ref, a.tag, a.elementPath].every((v) => string(v)) ||
    ![a.selector, a.role, a.name, a.text, a.nearbyText, a.source].every((v) => nullable(v)) ||
    !integer(a.revision) ||
    !integer(a.childCount) ||
    !rect(a.rect) ||
    typeof a.sensitive !== "boolean" ||
    typeof a.isFixed !== "boolean"
  )
    return false;
  if (a.bindingKey !== undefined && !string(a.bindingKey, 100)) return false;
  if (a.documentGeneration !== undefined && !string(a.documentGeneration, 100)) return false;
  if (a.selectedText !== undefined && !string(a.selectedText, BROWSER_ANNOTATION_SELECTED_TEXT_LIMIT)) return false;
  if (
    a.kind === "text" &&
    (!string(a.selectedText, BROWSER_ANNOTATION_SELECTED_TEXT_LIMIT) || !a.selectedText.length || a.sensitive)
  )
    return false;
  if (a.sensitive && (a.text !== null || a.nearbyText !== null || a.selectedText !== undefined || a.name !== null))
    return false;
  if (
    a.selectionRects !== undefined &&
    (!Array.isArray(a.selectionRects) || a.selectionRects.length > 64 || !a.selectionRects.every(rect))
  )
    return false;
  if (a.textLocator !== undefined) {
    const t = a.textLocator;
    if (
      !record(t) ||
      ![t.startPath, t.endPath].every(
        (path) => Array.isArray(path) && path.length <= 64 && path.every((n: unknown) => integer(n)),
      ) ||
      !integer(t.startOffset) ||
      !integer(t.endOffset)
    )
      return false;
  }
  if (
    a.framePath !== undefined &&
    (!Array.isArray(a.framePath) ||
      a.framePath.length > 8 ||
      !a.framePath.every(
        (f: unknown) =>
          record(f) &&
          nullable(f.selector) &&
          string(f.documentGeneration, 100) &&
          (f.frameId === undefined || string(f.frameId, 100)) &&
          (f.url === undefined || string(f.url)),
      ))
  )
    return false;
  if (a.elementName !== undefined && !string(a.elementName, 160)) return false;
  if (
    a.elementMetadata !== undefined &&
    (!record(a.elementMetadata) ||
      Object.keys(a.elementMetadata).length > 16 ||
      !Object.entries(a.elementMetadata).every(
        ([key, value]) =>
          key.length <= 80 &&
          (value === null ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value)) ||
            string(value, 256)),
      ))
  )
    return false;
  return true;
}

/** Reject malformed V2 atomically; never silently drop a target, intent or image. */
export function validateBrowserAnnotation(value: unknown): BrowserAnnotation | null {
  const a = annotationData(value);
  if (
    !record(a) ||
    !id(a.id) ||
    !string(a.tabId, 256) ||
    !a.tabId ||
    !integer(a.number, BROWSER_ANNOTATION_DRAFT_LIMIT) ||
    a.number < 1 ||
    !string(a.comment, 16000) ||
    !validAnchor(a.anchor) ||
    (a.surface !== undefined && a.surface !== "browser" && a.surface !== "file-preview") ||
    (a.screenshot !== null && !validAnnotationImage(a.screenshot))
  )
    return null;
  if (a.schemaVersion === undefined) {
    if (
      a.anchor.kind !== "element" ||
      [a.selections, a.styleIntents, a.textReplacements, a.evidence].some((v) => v !== undefined)
    )
      return null;
    return a as unknown as BrowserAnnotation;
  }
  if (
    a.schemaVersion !== 2 ||
    !Array.isArray(a.selections) ||
    !a.selections.length ||
    a.selections.length > BROWSER_ANNOTATION_SELECTION_LIMIT
  )
    return null;
  const ids = new Set<string>(),
    labels = new Set<string>();
  for (const s of a.selections) {
    if (
      !record(s) ||
      !id(s.id) ||
      !string(s.label, 16) ||
      !new RegExp(`^${a.number}[A-Z]+$`).test(s.label) ||
      !validAnchor(s.anchor) ||
      ids.has(s.id) ||
      labels.has(s.label)
    )
      return null;
    ids.add(s.id);
    labels.add(s.label);
  }
  // The first selection remains the V1-compatible primary anchor.
  if (canonical(a.anchor) !== canonical(a.selections[0].anchor)) return null;
  for (const key of ["styleIntents", "textReplacements", "evidence"])
    if (a[key] !== undefined && !Array.isArray(a[key])) return null;
  if (
    (a.styleIntents?.length ?? 0) > 64 ||
    (a.textReplacements?.length ?? 0) > BROWSER_ANNOTATION_SELECTION_LIMIT ||
    (a.evidence?.length ?? 0) + (a.screenshot ? 1 : 0) > BROWSER_ANNOTATION_IMAGE_LIMIT
  )
    return null;
  const styles = new Set<string>(),
    texts = new Set<string>();
  for (const s of a.styleIntents ?? []) {
    if (
      !record(s) ||
      !ids.has(s.selectionId) ||
      !BROWSER_ANNOTATION_STYLE_PROPERTIES.includes(s.property) ||
      !string(s.observedComputedValue, 256) ||
      !string(s.requestedValue, 256) ||
      !s.requestedValue.trim() ||
      /[;{}<>\\]|url\s*\(|expression\s*\(|@import/i.test(s.requestedValue)
    )
      return null;
    const key = `${s.selectionId}:${s.property}`;
    if (styles.has(key)) return null;
    styles.add(key);
  }
  for (const t of a.textReplacements ?? []) {
    if (
      !record(t) ||
      !ids.has(t.selectionId) ||
      texts.has(t.selectionId) ||
      !string(t.beforeText, 2000) ||
      !string(t.afterText, 2000)
    )
      return null;
    texts.add(t.selectionId);
  }
  const images = new Set<string>();
  for (const e of a.evidence ?? []) {
    if (
      !record(e) ||
      !id(e.id) ||
      images.has(e.id) ||
      !["target", "context"].includes(e.kind) ||
      !validAnnotationImage(e.dataUrl) ||
      (e.preface !== undefined && !string(e.preface, 1000)) ||
      !Array.isArray(e.selectionIds) ||
      !e.selectionIds.length ||
      e.selectionIds.length > 8 ||
      new Set(e.selectionIds).size !== e.selectionIds.length ||
      !e.selectionIds.every((sid: string) => ids.has(sid))
    )
      return null;
    images.add(e.id);
  }
  return a as unknown as BrowserAnnotation;
}
