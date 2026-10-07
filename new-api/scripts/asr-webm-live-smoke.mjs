// Explicit operator-only synthetic WebM/Opus smoke. Audio and credentials stay
// in memory/stdin; --send is required for the single paid supplier request.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
function option(name) {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) throw new Error(`Required: ${name}`)
  return args[index + 1]
}
const modelPath = option('--model-config')
const credentialsPath = option('--credentials')
const container = option('--media-container')
const config = JSON.parse(readFileSync(modelPath, 'utf8'))
const selection = config.defaultSpeechModel
const provider = config.providers.find((item) => item.id === selection?.providerId)
if (provider?.protocol !== 'hunyuan-asr' || provider.baseUrl !== 'https://tokenhub.tencentmaas.com/v1/wand/asrproxy') {
  throw new Error('Requires the configured TokenHub Hunyuan speech provider')
}
const send = args.includes('--send')
const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'))
const apiKey = credentials.entries[provider.credentialRef]
if (typeof apiKey !== 'string' || !apiKey) throw new Error('Speech credential unavailable')
// Both tools write audio only to stdout. No capture or encoded file is created.
const wav = execFileSync('docker', ['exec', container, 'espeak-ng', '--stdout', '-v', 'en', '-s', '145', 'This is a speech recognition format test.'], { maxBuffer: 1 << 20 })
const webm = execFileSync('docker', ['exec', '-i', container, 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '24k', '-f', 'webm', 'pipe:1'], { input: wav, maxBuffer: 1 << 20 })
const source = fileURLToPath(new URL('../', import.meta.url))
const payload = JSON.stringify({ audio: webm.toString('base64'), model: selection.modelId, api_key: send ? apiKey : '', send })
try {
  const result = execFileSync('docker', ['run', '--rm', '-i', '-e', 'HUNYUAN_ASR_SMOKE_STDIN=1', '-v', `${source}:/src`, '-v', 'newapi-hunyuan-go-cache:/go', '-v', 'newapi-hunyuan-build-cache:/root/.cache/go-build', '-w', '/src', 'golang:1.26-bookworm', 'sh', '-c', 'go test -c -o /tmp/asr-smoke.test ./relay/channel/advancedcustom && /tmp/asr-smoke.test -test.run=^TestHunyuanWebMStdinSmoke$ -test.v'], { input: payload, maxBuffer: 1 << 20, timeout: 120000 })
  process.stdout.write(result)
} catch (error) {
  // Do not dump child-process objects or stdin (credentials/Base64).
  process.stdout.write(error.stdout ?? '')
  process.stderr.write(error.stderr ?? '')
  process.exitCode = 1
}
