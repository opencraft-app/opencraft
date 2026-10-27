export type ModelInputModality = "text" | "image" | "audio";

/** Unknown metadata does not grant multimodal capabilities. */
export function modelInputModalities(value: readonly string[] | undefined | null): readonly ModelInputModality[] {
  return value == null ? ["text"] : [...new Set(value.filter((entry): entry is ModelInputModality =>
    entry === "text" || entry === "image" || entry === "audio"))];
}

export function unsupportedModelInput(
  modalities: readonly string[], input: readonly { readonly type: string }[],
): ModelInputModality | null {
  for (const entry of input) {
    const modality = entry.type === "image" || entry.type === "localImage" ? "image"
      : entry.type === "audio" || entry.type === "localAudio" ? "audio" : "text";
    if (!modalities.includes(modality)) return modality;
  }
  return null;
}
