#!/usr/bin/env node

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { deflateSync } from 'node:zlib'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const responseId = `chatcmpl_${crypto.randomUUID().replaceAll('-', '')}`
const expected = ['DSH WORKER OK 1', 'DSH WORKER OK 2', 'DSH WORKER OK AFTER CRASH']
const capabilityBindings = [{
  capabilityId: 'conversation.search',
  skill: {
    name: 'search-conversations',
    description: 'Search durable HyperNode conversations.',
    instructions: 'Call search_conversations when the user asks about conversation history.',
  },
  tool: {
    name: 'search_conversations',
    description: 'Search durable HyperNode conversations.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query.' },
    },
  },
}, {
  capabilityId: 'mcp-app.manage',
  skill: {
    name: 'build-mcp-app',
    description: 'Build a Hypernode MCP App from one sentence.',
    instructions: 'Generate the complete App and call manage_mcp_app with action publish. Do not create a standalone project.',
  },
  tool: {
    name: 'manage_mcp_app',
    description: 'Publish or inspect a Hypernode MCP App.',
    parameters: {
      action: { type: 'string', required: true, description: 'Action to perform.' },
      spec_json: { type: 'string', description: 'Serialized App spec.' },
    },
  },
}]
let requestCount = 0
const providerRequests = []
const tinyPng = createTinyPng().toString('base64')
const workspaceRoot = await mkdtemp(join(tmpdir(), 'hypernode-dsh-worker-'))
const workspacePort = 23_000 + Math.floor(Math.random() * 10_000)
const workspaceAgent = spawn(process.env.HYPERNODE_WORKSPACE_AGENT_BIN, [
  'workspace-agent', '--listen', `127.0.0.1:${workspacePort}`,
  '--root', workspaceRoot,
  '--db', join(workspaceRoot, 'agent.sqlite'),
  '--policy', new URL('../policy/workspace-agent.js', import.meta.url).pathname,
], { stdio: ['ignore', 'pipe', 'pipe'] })
let workspaceLogs = ''
workspaceAgent.stdout.on('data', chunk => { workspaceLogs += chunk })
workspaceAgent.stderr.on('data', chunk => { workspaceLogs += chunk })

const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }
  let body = ''
  for await (const chunk of request) body += chunk
  const payload = JSON.parse(body)
  providerRequests.push(payload)
  requestCount += 1
  if (request.headers.authorization !== 'Bearer smoke-secret') {
    response.writeHead(401).end('missing smoke credential')
    return
  }
  if (payload.model !== 'smoke-model' || payload.stream !== true) {
    response.writeHead(400).end('unexpected request shape')
    return
  }
  // The third request is deliberately killed after the DSH semantic request
  // checkpoint. A new worker must cold-repair that Turn before accepting the
  // next one; it must never splice the next user message into the crashed Turn.
  if (requestCount === 3) {
    await new Promise(resolve => response.once('close', resolve))
    return
  }

  const expectedText = requestCount === 4 ? expected[2] : expected[requestCount - 1]

  const events = [
    {
      id: responseId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: payload.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: expectedText }, finish_reason: null }],
    },
    {
      id: responseId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: payload.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
    },
  ]
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  response.write('data: [DONE]\n\n')
  response.end()
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
const sessionId = `smoke-${crypto.randomUUID()}`
let currentSessionId = sessionId
const persistencePath = join(
  workspaceRoot,
  `${createHash('sha256').update(sessionId).digest('hex')}.sqlite`,
)
const workerHomes = [join(workspaceRoot, 'home-a'), join(workspaceRoot, 'home-b')]
await Promise.all(workerHomes.map(home => mkdir(home, { recursive: true })))
let worker = startWorker(workerHomes[0])
let workerStderr = ''

try {
  worker.send({
    type: 'initialize',
    requestId: 'init-1',
    provider: 'smoke-provider',
    model: 'smoke-model',
    apiProtocol: 'openai-completions',
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    inputModalities: ['text', 'image'],
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    logicalSessionId: sessionId,
    sessionId: currentSessionId,
    cwd: workspaceRoot,
    workspace: {
      transport: 'ssh',
      host: '127.0.0.1',
      port: workspacePort,
      username: 'root',
    },
    capabilities: capabilityBindings,
  })
  const initialized = await waitFor(worker.messages, message => message.type === 'initialized')
  currentSessionId = initialized.snapshot.sessionId
  worker.send({
    type: 'turn/start',
    requestId: 'turn-1',
    turnId: 'client-turn-1',
    input: [
      { type: 'text', text: 'smoke image' },
      { type: 'image', url: `data:image/png;base64,${tinyPng}` },
    ],
  })
  await waitFor(worker.messages, message => (
    message.type === 'session-event' && message.clientTurnId === 'client-turn-1' &&
    message.event?.type === 'turn/end'
  ), 10_000)
  let sessionEvents = worker.messages
    .filter(message => message.type === 'session-event')
    .map(message => message.event)
  let assistant = sessionEvents.findLast(event => event.type === 'assistant/message')
  let text = assistant?.data?.message?.content
    ?.filter(block => block.type === 'text')
    .map(block => block.text)
    .join('') ?? ''
  if (text !== expected[0]) throw new Error(`unexpected worker assistant text ${JSON.stringify(text)}`)
  for (const type of ['turn/start', 'user/message', 'assistant/message', 'turn/end']) {
    if (!sessionEvents.some(event => event.type === type)) throw new Error(`missing worker event ${type}`)
  }
  workerStderr += await stopWorker(worker)
  // A collaborative Thread may be picked up by another user. The engine
  // ledger must follow the stable session id, not the worker's HOME.
  worker = startWorker(workerHomes[1])
  worker.send({
    type: 'initialize',
    requestId: 'init-2',
    provider: 'smoke-provider',
    model: 'smoke-model',
    apiProtocol: 'openai-completions',
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    inputModalities: ['text', 'image'],
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    logicalSessionId: sessionId,
    sessionId: currentSessionId,
    cwd: workspaceRoot,
    workspace: {
      transport: 'ssh',
      host: '127.0.0.1',
      port: workspacePort,
      username: 'root',
    },
    capabilities: capabilityBindings,
    expectExistingSession: true,
  })
  const resumed = await waitFor(worker.messages, message => message.type === 'initialized')
  if (resumed.snapshot?.provenance !== 'dsh-surface-generation-resume') {
    throw new Error(`expected DSH surface generation provenance, saw ${JSON.stringify(resumed.snapshot?.provenance)}`)
  }
  if (resumed.snapshot.sessionId === currentSessionId) {
    throw new Error('DSH surface resume did not advance the physical Runtime generation')
  }
  currentSessionId = resumed.snapshot.sessionId
  worker.send({
    type: 'turn/start',
    requestId: 'turn-2',
    turnId: 'client-turn-2',
    input: [{ type: 'text', text: 'second smoke' }],
  })
  await waitFor(worker.messages, message => (
    message.type === 'session-event' && message.clientTurnId === 'client-turn-2' &&
    message.event?.type === 'turn/end'
  ), 10_000)
  sessionEvents = worker.messages
    .filter(message => message.type === 'session-event')
    .map(message => message.event)
  assistant = sessionEvents.findLast(event => event.type === 'assistant/message')
  text = assistant?.data?.message?.content
    ?.filter(block => block.type === 'text')
    .map(block => block.text)
    .join('') ?? ''
  if (text !== expected[1]) {
    throw new Error(
      `unexpected second worker assistant text ${JSON.stringify(text)}; ` +
      `requestCount=${requestCount}; messages=${JSON.stringify(worker.messages)}`,
    )
  }
  if (requestCount !== 2) throw new Error(`expected two provider requests, saw ${requestCount}`)
  const resumedProviderBody = JSON.stringify(providerRequests[1])
  if (!resumedProviderBody.includes(expected[0]) || !resumedProviderBody.includes('smoke image')) {
    throw new Error(`native DSH resume did not restore prior context: ${resumedProviderBody}`)
  }
  const firstProviderTools = Array.isArray(providerRequests[0]?.tools)
    ? providerRequests[0].tools
    : []
  if (firstProviderTools.length === 0) {
    throw new Error('DSH worker did not expose any model-facing tools to the provider')
  }
  const firstProviderToolNames = firstProviderTools
    .map(tool => tool?.name ?? tool?.function?.name)
    .filter(Boolean)
  if (!firstProviderToolNames.includes('bash')) {
    throw new Error(`DSH worker did not expose bash: ${JSON.stringify(firstProviderToolNames)}`)
  }
  if (!firstProviderToolNames.includes('search_conversations')) {
    throw new Error(
      `DSH worker did not expose conversation search: ${JSON.stringify(firstProviderToolNames)}`,
    )
  }
  if (!firstProviderToolNames.includes('manage_mcp_app')) {
    throw new Error(
      `DSH worker did not expose MCP App Builder: ${JSON.stringify(firstProviderToolNames)}`,
    )
  }
  const firstProviderBody = JSON.stringify(providerRequests[0])
  if (!firstProviderBody.includes('search-conversations')) {
    throw new Error(`DSH worker did not publish the capability Skill catalog: ${firstProviderBody}`)
  }
  if (!firstProviderBody.includes('build-mcp-app')) {
    throw new Error(`DSH worker did not publish the MCP App Builder Skill: ${firstProviderBody}`)
  }
  if (!firstProviderBody.includes('image_url') || !firstProviderBody.includes('data:image/png;base64,')) {
    throw new Error(`DSH image did not reach provider request: ${firstProviderBody}`)
  }

  worker.send({
    type: 'turn/start',
    requestId: 'turn-crash',
    turnId: 'client-turn-crash',
    input: [{ type: 'text', text: 'crash after durable request checkpoint' }],
  })
  await waitForValue(() => requestCount, value => value === 3, 10_000)
  workerStderr += await killWorker(worker)
  worker = startWorker(workerHomes[0])
  worker.send({
    type: 'initialize',
    requestId: 'init-after-crash',
    provider: 'smoke-provider',
    model: 'smoke-model',
    apiProtocol: 'openai-completions',
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    inputModalities: ['text', 'image'],
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    logicalSessionId: sessionId,
    sessionId: currentSessionId,
    cwd: workspaceRoot,
    workspace: {
      transport: 'ssh',
      host: '127.0.0.1',
      port: workspacePort,
      username: 'root',
    },
    capabilities: capabilityBindings,
    expectExistingSession: true,
  })
  const repaired = await waitFor(worker.messages, message => message.type === 'initialized')
  if (repaired.snapshot?.provenance !== 'dsh-surface-generation-resume') {
    throw new Error(`expected DSH crash-tail generation provenance, saw ${JSON.stringify(repaired.snapshot?.provenance)}`)
  }
  if (!(repaired.snapshot?.recovery?.interruptedTurns > 0)) {
    throw new Error('DSH SQLite cold recovery did not close the crashed Turn as interrupted')
  }
  worker.send({
    type: 'turn/start',
    requestId: 'turn-after-crash',
    turnId: 'client-turn-after-crash',
    input: [{ type: 'text', text: 'continue after crash' }],
  })
  await waitFor(worker.messages, message => (
    message.type === 'session-event' && message.clientTurnId === 'client-turn-after-crash' &&
    message.event?.type === 'turn/end'
  ), 10_000)
  const postCrashAssistant = worker.messages
    .filter(message => message.type === 'session-event')
    .map(message => message.event)
    .findLast(event => event.type === 'assistant/message')
  const postCrashText = postCrashAssistant?.data?.message?.content
    ?.filter(block => block.type === 'text')
    .map(block => block.text)
    .join('') ?? ''
  if (postCrashText !== expected[2]) {
    const messageSummary = worker.messages.map(message => ({
      type: message.type,
      clientTurnId: message.clientTurnId,
      eventType: message.event?.type,
      reason: message.event?.data?.reason,
      message: message.message,
    }))
    throw new Error(
      `unexpected post-crash assistant text ${JSON.stringify(postCrashText)}; ` +
      `requestCount=${requestCount}; messages=${JSON.stringify(messageSummary)}`,
    )
  }
  if (worker.messages.some(message => message.type === 'turn-rejected')) {
    throw new Error('post-crash user input was rejected instead of starting a fresh DSH Turn')
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    text,
    requestCount,
    resumedAfterWorkerRestart: true,
    repairedAfterHardCrash: true,
    imageReachedProvider: true,
    toolCount: firstProviderTools.length,
    toolNames: firstProviderToolNames,
    eventTypes: sessionEvents.map(event => event.type),
  })}\n`)
} finally {
  workerStderr += await stopWorker(worker)
  server.close()
  workspaceAgent.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => workspaceAgent.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2_000)),
  ])
  if (!workspaceAgent.killed) workspaceAgent.kill('SIGKILL')
  await rm(workspaceRoot, { recursive: true, force: true })
  if (workerStderr) process.stderr.write(workerStderr)
  if (workspaceAgent.exitCode && workspaceLogs) process.stderr.write(workspaceLogs)
}

function startWorker(home) {
  const child = spawn(process.execPath, ['scripts/dsh-engine-worker.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      HYPERNODE_DSH_API_KEY: 'smoke-secret',
      HYPERNODE_DSH_PERSISTENCE_ROOT: workspaceRoot,
      HYPERNODE_DSH_HOME_ROOT: join(workspaceRoot, 'dsh-home'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const messages = []
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', line => messages.push(JSON.parse(line)))
  return {
    child,
    messages,
    send(value) {
      child.stdin.write(`${JSON.stringify(value)}\n`)
    },
    stderr() {
      return stderr
    },
  }
}

async function stopWorker(worker) {
  if (!worker?.child || worker.child.exitCode !== null) return worker?.stderr?.() ?? ''
  worker.send({ type: 'dispose', requestId: `dispose-${crypto.randomUUID()}` })
  worker.child.stdin.end()
  await Promise.race([
    new Promise(resolve => worker.child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2_000)),
  ])
  if (worker.child.exitCode === null) worker.child.kill('SIGKILL')
  return worker.stderr()
}

async function killWorker(worker) {
  if (!worker?.child || worker.child.exitCode !== null) return worker?.stderr?.() ?? ''
  worker.child.kill('SIGKILL')
  await new Promise(resolve => worker.child.once('exit', resolve))
  return worker.stderr()
}

async function waitForValue(read, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for value; latest=${JSON.stringify(read())}`)
}

function waitFor(messages, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = setInterval(() => {
      const found = messages.find(predicate)
      if (found) {
        clearInterval(timer)
        resolve(found)
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer)
        reject(new Error(`timed out waiting for worker event; messages=${JSON.stringify(messages)}`))
      }
    }, 10)
  })
}

function createTinyPng() {
  const chunk = (type, data) => {
    const name = Buffer.from(type, 'ascii')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
    return Buffer.concat([length, name, data, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
