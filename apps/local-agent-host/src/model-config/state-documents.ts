import { StateDocumentCorruptError } from "@opencraft/document-storage/state";

/** User-visible over RPC; kept identical to the previous JSON helper's message. */
export const CORRUPT_CONFIGURATION_MESSAGE = "配置 JSON 损坏，未覆盖原文件";

/** Maps the storage port's corruption error to the Host's configuration message. */
export async function configurationDocument<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof StateDocumentCorruptError) throw new Error(CORRUPT_CONFIGURATION_MESSAGE, { cause: error });
    throw error;
  }
}
