import { deserialize } from "bson";
import { decodeUtf8 } from "./utf8";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function decodeBase64(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return decodeUtf8(bytes);
}

export async function decodeTencentTatFrame(
  frame: string | Blob | ArrayBuffer,
): Promise<unknown> {
  if (typeof frame === "string") return JSON.parse(frame);
  if (frame instanceof Blob) return decodeTencentTatFrame(await frame.arrayBuffer());
  const bytes = new Uint8Array(frame);
  try {
    return deserialize(bytes);
  } catch {
    return JSON.parse(decodeUtf8(bytes));
  }
}

export function extractTencentPtyOutput(message: unknown): string {
  const payload = asRecord(asRecord(message)?.Data);
  if (payload === null) return "";
  const candidates = [
    payload.Output,
    payload.Data,
    asRecord(payload.Data)?.Output,
    asRecord(payload.Data)?.Data,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      try {
        return decodeBase64(candidate);
      } catch {
        return candidate;
      }
    }
    if (candidate instanceof Uint8Array) return decodeUtf8(candidate);
    if (candidate instanceof ArrayBuffer) return decodeUtf8(new Uint8Array(candidate));
  }
  return "";
}

export function extractTencentTatError(message: unknown): string {
  const root = asRecord(message);
  const payload = asRecord(root?.Data);
  const candidates = [
    payload?.Message,
    payload?.ErrMsg,
    payload?.Error,
    payload?.ErrorMessage,
    payload?.Reason,
    root?.Message,
    root?.ErrMsg,
    root?.Error,
    root?.ErrorMessage,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "TAT session error";
}
