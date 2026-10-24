import { randomUUID } from "node:crypto";
import { HUNYUAN_SPEECH } from "./speech.js";
import { ModelConfigurationConflict, type ModelConfigurationRepository, type ModelCredentialRepository } from "./repository.js";

/** Explicit import only. This module is never invoked by server startup. */
export async function migrateSpeechEnvironment(repository: ModelConfigurationRepository, credentials: ModelCredentialRepository,
  source: Readonly<Record<string, string | undefined>>) {
  const doc = await repository.initialize();
  if (doc.defaultSpeechModel) return { migrated: false as const };
  const id = "speech-hunyuan";
  if (doc.providers.some(p => p.id === id)) throw new Error("语音连接已存在，请在模型服务中配置，不自动覆盖");
  const key = source.OPENCRAFT_SPEECH_API_KEY;
  const model = source.OPENCRAFT_SPEECH_MODEL || HUNYUAN_SPEECH.model;
  if (!key?.trim() || /[\r\n\0]/u.test(key) || !/^[a-zA-Z0-9._-]{1,100}$/u.test(model)) throw new Error("旧语音配置无效，未导入");
  const ref = `OPENCRAFT_PROVIDER_${randomUUID().replaceAll("-", "_")}`;
  await credentials.set(ref, key.trim());
  try {
    await repository.update(doc.revision, draft => {
      draft.providers.push({ id, name: "混元语音", protocol: HUNYUAN_SPEECH.api, baseUrl: HUNYUAN_SPEECH.baseURL,
        enabled: true, credentialRef: ref, models: [{ id: model, type: "asr", enabled: true }] });
      draft.defaultSpeechModel = { providerId: id, modelId: model };
    });
  } catch (error) {
    // Only a definite CAS rejection permits cleanup; an uncertain write must not lose its credential.
    if (error instanceof ModelConfigurationConflict) await credentials.remove(ref);
    throw new Error("导入未确认，请在模型服务中核对后再操作");
  }
  return { migrated: true as const };
}
