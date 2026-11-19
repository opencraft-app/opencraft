// Voice messages become text with the installation's configured speech model (Model Services →
// speech), sent in their original WeCom format (amr/speex/silk). Best effort: on any failure the
// timeline keeps "[语音]".
import { join } from 'node:path';
import { deploymentPaths } from '../../../../scripts/container-deployment/paths.mjs';
import { SpeechModelConfiguration } from '../../../../apps/local-agent-host/src/model-config/speech.ts';
import { ModelConfigurationRepository, ModelCredentialRepository } from '../../../../apps/local-agent-host/src/model-config/repository.ts';

const ENDPOINT = 'https://tokenhub.tencentmaas.com/v1/wand/asrproxy/sync_transcribe';
const FORMATS = new Set(['amr', 'speex', 'silk', 'mp3', 'wav', 'm4a', 'aac', 'ogg-opus']);
export const MAX_VOICE_BYTES = 4 * 1024 * 1024;

export function defaultSpeech() {
  const models = join(deploymentPaths().dataDirectory, 'models');
  const configuration = new SpeechModelConfiguration(new ModelConfigurationRepository(models), new ModelCredentialRepository(models));
  return async () => (await configuration.read()).config;
}

/** Transcript text, or '' when speech is not configured, the format is unknown or recognition fails. */
export async function transcribeVoice(bytes, format, { speech = defaultSpeech(), fetcher = fetch, signal } = {}) {
  const kind = String(format ?? '').toLowerCase() || 'amr';
  if (!FORMATS.has(kind) || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_VOICE_BYTES) return '';
  try {
    const config = await speech();
    if (!config?.apiKey) return '';
    const response = await fetcher(ENDPOINT, { method: 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, data: Buffer.from(bytes).toString('base64'), voice_encode_format: kind }) });
    if (!response.ok) { await response.body?.cancel(); return ''; }
    const data = await response.json();
    const text = data?.status === 'completed' && typeof data?.output?.text === 'string' ? data.output.text.trim() : '';
    return text.slice(0, 8000);
  } catch (error) { if (signal?.aborted) throw error; return ''; }
}
