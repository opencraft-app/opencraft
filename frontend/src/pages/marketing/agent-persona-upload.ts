export const PERSONA_MARKDOWN_MAX_BYTES = 20 * 1024;
export const PERSONA_DISPLAY_NAME_MAX_BYTES = 80;
export const PERSONA_CONTENT_SHORT_THRESHOLD = 100;
export const CUSTOM_PERSONA_SLUG = "custom-upload";

export type PersonaMarkdownErrorCode =
  | "invalid_extension"
  | "too_large"
  | "invalid_utf8"
  | "read_failed"
  | "empty"
  | "control_characters";

export type PersonaMarkdownValidation =
  | {
    valid: true;
    text: string;
    byteLength: number;
  }
  | {
    valid: false;
    code: PersonaMarkdownErrorCode;
    byteLength: number;
  };

export type CustomSoulMarkdownValidation =
  | {
    valid: true;
    markdown: string;
    displayName: string;
    byteLength: number;
  }
  | {
    valid: false;
    code: PersonaMarkdownErrorCode;
    byteLength: number;
  };

export type PersonaStructureWarning =
  | "missing_name"
  | "missing_identity"
  | "missing_tone"
  | "missing_principles"
  | "missing_boundaries"
  | "content_too_short";

const utf8Encoder = new TextEncoder();
const forbiddenControlCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

const stripBom = (text: string) => text.replace(/^\uFEFF/, "");

export function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function truncateUtf8(text: string, maxBytes: number): string {
  let result = "";
  let byteLength = 0;
  for (const character of text) {
    const characterBytes = utf8Encoder.encode(character).byteLength;
    if (byteLength + characterBytes > maxBytes) break;
    result += character;
    byteLength += characterBytes;
  }
  return result;
}

export function validatePersonaMarkdownText(text: string): PersonaMarkdownValidation {
  const normalized = stripBom(text);
  const byteLength = utf8Encoder.encode(normalized).byteLength;
  if (byteLength > PERSONA_MARKDOWN_MAX_BYTES) {
    return { valid: false, code: "too_large", byteLength };
  }
  if (!normalized.trim()) {
    return { valid: false, code: "empty", byteLength };
  }
  if (forbiddenControlCharacters.test(normalized)) {
    return { valid: false, code: "control_characters", byteLength };
  }
  return { valid: true, text: normalized, byteLength };
}

export async function readPersonaMarkdownFile(
  file: File,
): Promise<PersonaMarkdownValidation> {
  if (!/\.md$/i.test(file.name)) {
    return { valid: false, code: "invalid_extension", byteLength: file.size };
  }
  if (file.size > PERSONA_MARKDOWN_MAX_BYTES) {
    return { valid: false, code: "too_large", byteLength: file.size };
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return { valid: false, code: "read_failed", byteLength: 0 };
  }
  if (bytes.byteLength > PERSONA_MARKDOWN_MAX_BYTES) {
    return { valid: false, code: "too_large", byteLength: bytes.byteLength };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { valid: false, code: "invalid_utf8", byteLength: bytes.byteLength };
  }
  return validatePersonaMarkdownText(text);
}

export function getPersonaDisplayName(markdown: string, fileName: string): string {
  const metadataName = markdown.match(/^\s*Name\s*:\s*(.*?)\s*$/im)?.[1]?.trim();
  const fileNameWithoutExtension = fileName.replace(/\.md$/i, "").trim();
  const rawDisplayName = metadataName || fileNameWithoutExtension || "自定义人设";
  const displayName = rawDisplayName
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim() || "自定义人设";
  return truncateUtf8(displayName, PERSONA_DISPLAY_NAME_MAX_BYTES);
}

export function getPersonaStructureWarnings(
  markdown: string,
): PersonaStructureWarning[] {
  const warnings: PersonaStructureWarning[] = [];
  if (!/^\s*Name\s*:\s*\S+/im.test(markdown)) warnings.push("missing_name");
  if (!/(^#{1,6}\s*(身份|角色定位|角色|identity|role)(?:\s|$|[:：])|身份\s*[:：]|角色\s*[:：])/im.test(markdown)) {
    warnings.push("missing_identity");
  }
  if (!/(^#{1,6}\s*(沟通风格|语气|表达|communication\s+style|tone|voice|style)(?:\s|$|[:：])|语气\s*[:：]|表达\s*[:：])/im.test(markdown)) {
    warnings.push("missing_tone");
  }
  if (!/(^#{1,6}\s*(工作原则|原则|优先级|working\s+principles?|principles?|priorit(?:y|ies))(?:\s|$|[:：])|原则\s*[:：]|优先级\s*[:：])/im.test(markdown)) {
    warnings.push("missing_principles");
  }
  if (!/(^#{1,6}\s*(行为边界|边界|禁止|behaviou?r(?:al)?\s+boundar(?:y|ies)|boundar(?:y|ies)|limits?)(?:\s|$|[:：])|不得|不要|禁止|do not|never)/im.test(markdown)) {
    warnings.push("missing_boundaries");
  }
  if ([...markdown.trim()].length < PERSONA_CONTENT_SHORT_THRESHOLD) {
    warnings.push("content_too_short");
  }
  return warnings;
}

export function buildCustomSoulMarkdown(
  markdown: string,
  fileName: string,
): { markdown: string; displayName: string } {
  const normalized = stripBom(markdown).replace(/\r\n?/g, "\n").trimEnd();
  const displayName = getPersonaDisplayName(normalized, fileName);
  const lines = normalized.split("\n");
  const soulHeadingIndex = lines.findIndex((line) => /^#\s+Soul\s*$/i.test(line));
  const contentHeadingIndex = lines.findIndex(
    (line, index) => index > soulHeadingIndex && /^##\s+Content\s*$/i.test(line),
  );

  if (soulHeadingIndex >= 0 && contentHeadingIndex > soulHeadingIndex) {
    const firstSectionIndex = lines.findIndex(
      (line, index) => index > soulHeadingIndex && /^##\s+/.test(line),
    );
    const metadataEnd = firstSectionIndex >= 0 ? firstSectionIndex : lines.length;
    const metadata = lines.slice(soulHeadingIndex + 1, metadataEnd);
    const slugIndex = metadata.findIndex((line) => /^\s*Slug\s*:/i.test(line));

    if (slugIndex >= 0) {
      metadata[slugIndex] = `Slug: ${CUSTOM_PERSONA_SLUG}`;
    } else {
      metadata.unshift(`Slug: ${CUSTOM_PERSONA_SLUG}`);
    }
    const nameIndex = metadata.findIndex((line) => /^\s*Name\s*:/i.test(line));
    if (nameIndex < 0) {
      const insertedSlugIndex = metadata.findIndex((line) => /^Slug\s*:/i.test(line));
      metadata.splice(insertedSlugIndex + 1, 0, `Name: ${displayName}`);
    } else {
      metadata[nameIndex] = `Name: ${displayName}`;
    }

    return {
      displayName,
      markdown: [
        ...lines.slice(0, soulHeadingIndex + 1),
        ...metadata,
        ...lines.slice(metadataEnd),
      ].join("\n").trimEnd() + "\n",
    };
  }

  return {
    displayName,
    markdown: [
      "# Soul",
      `Slug: ${CUSTOM_PERSONA_SLUG}`,
      `Name: ${displayName}`,
      "",
      "## Content",
      normalized,
      "",
    ].join("\n"),
  };
}

export function validateCustomSoulMarkdown(
  markdown: string,
  fileName: string,
): CustomSoulMarkdownValidation {
  const sourceValidation = validatePersonaMarkdownText(markdown);
  if (!sourceValidation.valid) return sourceValidation;

  const payload = buildCustomSoulMarkdown(sourceValidation.text, fileName);
  const finalValidation = validatePersonaMarkdownText(payload.markdown);
  if (!finalValidation.valid) return finalValidation;

  return {
    valid: true,
    markdown: payload.markdown,
    displayName: payload.displayName,
    byteLength: finalValidation.byteLength,
  };
}
