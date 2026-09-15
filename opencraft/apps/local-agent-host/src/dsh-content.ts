type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    const value = object(part);
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("");
}

export function userContent(content: unknown): RecordValue[] {
  if (!Array.isArray(content)) return contentText(content) === "" ? [] : [{ type: "text", text: contentText(content), text_elements: [] }];
  return content.flatMap<RecordValue>((raw) => {
    const block = object(raw);
    if (block.type === "text" && typeof block.text === "string") {
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
