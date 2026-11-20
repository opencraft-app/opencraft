import type { BrowserAnnotation } from "@opencraft/browser-core";
import { annotationBlock, BROWSER_COMMENTS_GUIDANCE, BROWSER_COMMENTS_SECTION, describeTarget, evidencePreface, screenshotPreface, safeAnnotationUrl } from "./serialize";
import { annotationData, validateBrowserAnnotation, validAnnotationImage, BROWSER_ANNOTATION_DRAFT_LIMIT, BROWSER_ANNOTATION_DRAFT_SELECTION_LIMIT, BROWSER_ANNOTATION_DRAFT_IMAGE_LIMIT, BROWSER_ANNOTATION_DRAFT_BYTES_LIMIT } from "./validation";
export * from "./validation";

export const BROWSER_ANNOTATION_REFERENCE_PREFIX = "browser-annotation:";

/** Generic inputImages carries each image once; evidence stubs preserve ownership. */
export function annotationContextReference(annotation: BrowserAnnotation) {
  const valid = validateBrowserAnnotation(annotation);
  if (!valid) throw new Error("Invalid browser annotation");
  const comment = valid.comment.trim();
  const images = (valid.evidence ?? []).map(e => ({ url: e.dataUrl, preface: evidencePreface(valid, e) }));
  if (valid.screenshot) images.push({ url: valid.screenshot, preface: screenshotPreface(valid) });
  return {
    id: BROWSER_ANNOTATION_REFERENCE_PREFIX + valid.id,
    kind: "annotation" as const,
    title: comment ? `${describeTarget(valid.anchor)}: ${comment}` : describeTarget(valid.anchor),
    uri: safeAnnotationUrl(valid.anchor.url),
    visible: true,
    metadata: {
      inputSection: BROWSER_COMMENTS_SECTION,
      inputSectionPreamble: BROWSER_COMMENTS_GUIDANCE,
      inputOrder: valid.number,
      inputText: annotationBlock(valid),
      ...(valid.schemaVersion === 2
        ? { inputImages: images, browserAnnotationLegacyScreenshot: Boolean(valid.screenshot) }
        : valid.screenshot ? { inputImage: valid.screenshot, inputImagePreface: screenshotPreface(valid) } : {}),
      badge: String(valid.number),
      chip: true,
      browserAnnotation: {
        ...valid,
        screenshot: null,
        ...(valid.evidence ? { evidence: valid.evidence.map(({ dataUrl: _dataUrl, ...e }) => e) } : {}),
      },
    },
  };
}

export function annotationFromReference(reference: { readonly id: string; readonly metadata?: Readonly<Record<string, unknown>> }): BrowserAnnotation | null {
  const clean = annotationData(reference) as typeof reference | null;
  if (!clean || typeof clean.id !== "string" || !clean.id.startsWith(BROWSER_ANNOTATION_REFERENCE_PREFIX)) return null;
  const value = clean.metadata?.browserAnnotation as BrowserAnnotation | undefined;
  if (!value || typeof value !== "object" || clean.id !== BROWSER_ANNOTATION_REFERENCE_PREFIX + value.id) return null;
  if (value.schemaVersion === 2) {
    const images = clean.metadata?.inputImages;
    const legacy = clean.metadata?.browserAnnotationLegacyScreenshot === true;
    if (!Array.isArray(images) || !Array.isArray(value.selections) || (value.evidence !== undefined && !Array.isArray(value.evidence))
      || images.length !== (value.evidence?.length ?? 0) + Number(legacy)
      || !images.every(image => image && typeof image === "object" && validAnnotationImage(image.url))) return null;
    return validateBrowserAnnotation({ ...value,
      evidence: (value.evidence ?? []).map((e, i) => ({ ...e, dataUrl: images[i].url })),
      screenshot: legacy ? images.at(-1).url : null,
    });
  }
  const image = clean.metadata?.inputImage;
  return validateBrowserAnnotation({ ...value, screenshot: validAnnotationImage(image) ? image : null });
}

/** Validate before atomically adding/replacing references in a Composer draft. */
export function assertAnnotationDraftBudget(annotations: readonly BrowserAnnotation[]): void {
  if (annotations.length > BROWSER_ANNOTATION_DRAFT_LIMIT) throw new Error("A draft supports at most 8 browser annotations");
  const ids = new Set<string>(), numbers = new Set<number>();
  let selections = 0, images = 0;
  for (const annotation of annotations) {
    if (!validateBrowserAnnotation(annotation)) throw new Error("Invalid browser annotation");
    if (ids.has(annotation.id) || numbers.has(annotation.number)) throw new Error("Duplicate annotation identity or number");
    ids.add(annotation.id); numbers.add(annotation.number);
    selections += annotation.selections?.length ?? 1;
    images += (annotation.evidence?.length ?? 0) + Number(Boolean(annotation.screenshot));
  }
  if (selections > BROWSER_ANNOTATION_DRAFT_SELECTION_LIMIT) throw new Error("A draft supports at most 32 annotation targets");
  if (images > BROWSER_ANNOTATION_DRAFT_IMAGE_LIMIT) throw new Error("A draft supports at most 8 annotation images");
  if (new TextEncoder().encode(JSON.stringify(annotations.map(annotationContextReference))).length > BROWSER_ANNOTATION_DRAFT_BYTES_LIMIT) throw new Error("Browser annotations exceed the draft storage budget");
}
