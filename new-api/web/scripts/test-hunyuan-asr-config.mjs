import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  getAdvancedCustomConverterDefaults,
  getAdvancedCustomConverterOptions,
  getAdvancedCustomIncomingPathOptions,
  getDefaultAdvancedCustomIncomingPath,
  isAdvancedCustomIncomingPathAllowed,
  parseAdvancedCustomConfig,
  stringifyAdvancedCustomConfig,
  validateAdvancedCustomConfig,
} from '../src/features/channels/lib/advanced-custom.ts'

const converter = 'openai_transcriptions_to_hunyuan_asr'
const incomingPath = '/v1/audio/transcriptions'
assert.equal(getDefaultAdvancedCustomIncomingPath(converter), incomingPath)
assert.deepEqual(
  getAdvancedCustomIncomingPathOptions(converter).map((option) => option.value),
  [incomingPath]
)
const defaults = getAdvancedCustomConverterDefaults(converter, incomingPath)
assert.equal(defaults.upstream_path, '/v1/wand/asrproxy/sync_transcribe')
assert.deepEqual(defaults.auth, {
  type: 'header',
  name: 'Authorization',
  value: 'Bearer {api_key}',
})
assert.ok(
  getAdvancedCustomConverterOptions(incomingPath).some(
    (option) => option.value === converter
  )
)
for (const path of [
  '/v1/chat/completions',
  '/v1/audio/translations',
  '/v1/audio/speech',
]) {
  assert.equal(isAdvancedCustomIncomingPathAllowed(path, converter), false)
  assert.equal(
    getAdvancedCustomConverterOptions(path).some(
      (option) => option.value === converter
    ),
    false
  )
}
const config = {
  advanced_routes: [{ incoming_path: incomingPath, converter, ...defaults }],
}
assert.equal(validateAdvancedCustomConfig(config), null)
assert.deepEqual(
  parseAdvancedCustomConfig(stringifyAdvancedCustomConfig(config)),
  config
)
for (const locale of ['zh', 'zh-TW', 'en', 'ja', 'fr', 'ru', 'vi']) {
  const catalog = JSON.parse(
    readFileSync(
      new URL(`../src/i18n/locales/${locale}.json`, import.meta.url),
      'utf8'
    )
  )
  assert.ok(catalog.translation['Hunyuan ASR'])
}
console.log('Hunyuan ASR channel configuration tests passed')
