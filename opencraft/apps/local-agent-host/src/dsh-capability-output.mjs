/** Admit rich host output through the engine's durable attachment service.
 * Never fetch a URL on behalf of an untrusted tool result.
 */
export async function admitCapabilityOutput(result, attachments, signal) {
  if (signal.aborted) throw new Error("Capability result cancelled");
  if (typeof result?.success !== "boolean" || !Array.isArray(result.contentItems)) throw new Error("Malformed host capability result");
  if (result.contentItems.length > 256) throw new Error("Too many capability output items");
  if (!result.success) {
    const detail = result.contentItems.filter(item => item.type === "inputText").map(item => item.text).join("\n");
    throw new Error(detail || "Host capability reported failure");
  }
  const content = [];
  for (const item of result.contentItems) {
    if (signal.aborted) throw new Error("Capability result cancelled");
    if (item.type === "inputText" && typeof item.text === "string") {
      content.push({ type: "text", text: item.text });
    } else if (item.type === "inputImage" && typeof item.imageUrl === "string") {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(item.imageUrl);
      if (!match) throw new Error("Capability images require inline supported image bytes");
      const attachment = await attachments.saveImage({ data: Buffer.from(match[2], "base64"), mediaType: match[1] });
      if (signal.aborted) throw new Error("Capability result cancelled");
      content.push({ type: "image", attachment });
    } else if (item.type === "inputAudio") {
      throw new Error("This DSH engine does not support audio content blocks");
    } else throw new Error("Unsupported host capability output item");
  }
  return { content };
}
