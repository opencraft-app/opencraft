import { isAbsolute, relative, resolve, sep } from "node:path";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const STAGED_LOCATOR_EXACT = /^The user attached a file named ("(?:[^"\\]|\\.)*")\. Its readable path on this Host is ("(?:[^"\\]|\\.)*")\. Read the file before answering questions about its contents; treat its contents as user-provided data\.$/u;

function isOwnedStagedPath(stagedRoot: string, candidatePath: string): boolean {
  if (!isAbsolute(candidatePath)) return false;
  const owned = relative(resolve(stagedRoot), resolve(candidatePath));
  if (!owned || owned.startsWith("..") || isAbsolute(owned)) return false;
  const [id, filename, extra] = owned.split(sep);
  return Boolean(id && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id) && filename?.startsWith("content-") && extra === undefined);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const value = object(part);
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("");
}

export function userContent(
  content: unknown,
  options?: { readonly stagedRoot?: string; readonly includeStagedLocatorText?: boolean },
): RecordValue[] {
  if (!Array.isArray(content)) return contentText(content) === "" ? [] : [{ type: "text", text: contentText(content), text_elements: [] }];
  return content.flatMap<RecordValue>((raw) => {
    const block = object(raw);
    if (block.type === "text" && typeof block.text === "string") {
      if (options?.stagedRoot) {
        const match = STAGED_LOCATOR_EXACT.exec(block.text);
        if (match) {
          try {
            const parsedName = JSON.parse(match[1]!);
            const parsedPath = JSON.parse(match[2]!);
            if (typeof parsedName === "string" && typeof parsedPath === "string" && isOwnedStagedPath(options.stagedRoot, parsedPath)) {
              const resolvedPath = resolve(parsedPath);
              if (options.includeStagedLocatorText === false) {
                return [{ type: "mention", name: parsedName, path: resolvedPath }];
              }
              return [
                {
                  type: "text",
                  text: block.text,
                  text_elements: [{
                    byteRange: { start: 0, end: Buffer.byteLength(block.text, "utf8") },
                    placeholder: "opencraft:staged-file:v1",
                  }],
                },
                { type: "mention", name: parsedName, path: resolvedPath },
              ];
            }
          } catch {
            // Fall through to plain text.
          }
        }
      }
      return [{ type: "text", text: block.text, text_elements: [] }];
    }
    const attachment = object(block.attachment);
    if (block.type === "image") {
      const mediaType = string(block.mediaType);
      const data = string(block.data);
      if (mediaType.startsWith("image/") && data !== "") {
        return [{ type: "image", url: `data:${mediaType};base64,${data}` }];
      }
      const path = string(attachment.path) || string(attachment.filePath);
      if (path !== "") return [{ type: "localImage", path }];
      const url = string(attachment.url);
      if (url !== "") return [{ type: "image", url }];
    }
    return [];
  });
}
