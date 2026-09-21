#!/usr/bin/env node

import { createInterface } from 'node:readline'
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import * as AgentSpine from '@deepseek-ai/dsh-agent-spine-demo'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  dshContentFromAppInput,
  normalizeDshInputModalities,
} from './dsh-input-content.mjs'
import SshSubprocessRuntime from './dsh-subprocess-ssh.mjs'
import {
  advanceSurface,
  currentSurfaceEvents,
  surfaceToSeed,
} from './dsh-surface-checkpoint.mjs'

const API_KEY_ENV = 'HYPERNODE_DSH_API_KEY'

let ctx = null
let agent = null
let agentHandle = null
let sessionId = null
let logicalSessionId = null
let checkpointGeneration = 0
let checkpointChain = Promise.resolve()
let activeClientTurnId = null
let pendingClientTurnId = null
let initialized = false
let commandChain = Promise.resolve()
let providerInputModalities = ['text']
let nativeSessionSnapshot = null
let nativeSessionMaterialized = false
let capabilitySequence = 0
const pendingCapabilityCalls = new Map()

function capabilityCall(binding, args, signal) {
  const requestId = `capability-${process.pid}-${++capabilitySequence}`
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCapabilityCalls.delete(requestId)
      reject(new Error(`${binding.capabilityId} timed out after 10000ms`))
    }, 10_000)
    const onAbort = () => {
      clearTimeout(timeout)
      pendingCapabilityCalls.delete(requestId)
      emit({ type: 'capability-cancel', requestId })
      reject(signal.reason instanceof Error ? signal.reason : new Error('capability call aborted'))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    pendingCapabilityCalls.set(requestId, {
      resolve(value) {
        clearTimeout(timeout)
        signal?.removeEventListener?.('abort', onAbort)
        resolve(value)
      },
      reject(error) {
        clearTimeout(timeout)
        signal?.removeEventListener?.('abort', onAbort)
        reject(error)
      },
    })
    emit({
      type: 'capability-request',
      requestId,
      capabilityId: binding.capabilityId,
      arguments: args,
    })
  })
}

async function materializeCapabilitySkills(bindings, dshHome) {
  if (!dshHome) return
  const manifestPath = join(dshHome, 'capability-skills.json')
  let previousNames = []
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest?.version === 1 && Array.isArray(manifest.names)) {
      previousNames = manifest.names.filter(name => typeof name === 'string')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const desired = new Map()
  for (const binding of bindings) {
    const skill = binding?.skill
    if (!skill?.name || !skill?.description || !skill?.instructions) continue
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(skill.name)) {
      throw new Error(`invalid capability skill name ${JSON.stringify(skill.name)}`)
    }
    desired.set(skill.name, skill)
  }
  for (const name of previousNames) {
    if (desired.has(name) || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) continue
    await rm(join(dshHome, 'skills', name), { recursive: true, force: true })
  }
  for (const skill of desired.values()) {
    const directory = join(dshHome, 'skills', skill.name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), [
      '---',
      `name: ${skill.name}`,
      `description: ${skill.description}`,
      '---',
      '',
      `# ${skill.name}`,
      '',
      skill.instructions,
      '',
    ].join('\n'), { mode: 0o600 })
  }
  await mkdir(dshHome, { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify({
    version: 1,
    names: [...desired.keys()].sort(),
  })}\n`, { mode: 0o600 })
}

function registerCapabilityTools(bindings) {
  for (const binding of bindings) {
    const tool = binding?.tool
    if (!binding?.capabilityId || !tool?.name || !tool?.description) continue
    ctx.tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? {},
      timeoutMs: 12_000,
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: (args, execution) => capabilityCall(binding, args, execution.signal),
    }))
  }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function fail(requestId, error) {
  emit({
    type: 'error',
    requestId: requestId ?? null,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  })
}

function defaultPersistencePath(id) {
  const root = String(process.env.HYPERNODE_DSH_PERSISTENCE_ROOT ?? '').trim()
  if (!root) return join(homedir(), '.hypernode', 'dsh-sessions.sqlite')
  const digest = createHash('sha256').update(String(id)).digest('hex')
  return join(root, `${digest}.sqlite`)
}

function persistencePathFor(command, id, requestedId = id) {
  const explicit = String(command.persistencePath ?? '').trim()
  return explicit && String(id) === String(requestedId) ? explicit : defaultPersistencePath(id)
}

function defaultCheckpointPath(id) {
  const root = String(process.env.HYPERNODE_DSH_PERSISTENCE_ROOT ?? '').trim()
    || join(homedir(), '.hypernode')
  const digest = createHash('sha256').update(String(id)).digest('hex')
  return join(root, 'surface-checkpoints', `${digest}.json`)
}

function defaultDshHome(id) {
  const root = String(process.env.HYPERNODE_DSH_HOME_ROOT ?? '').trim()
  if (!root) return undefined
  const digest = createHash('sha256').update(String(id)).digest('hex')
  return join(root, digest)
}

async function installPersistence(command, id, requestedId = id) {
  const path = persistencePathFor(command, id, requestedId)
  await mkdir(dirname(path), { recursive: true })
  await ctx.plugin(SqliteSessionPersistence, {
    path,
    journalMode: 'wal',
    // Semantic checkpoints remain the hard durability boundary. The short
    // batch window merely coalesces ordinary chunks between those boundaries.
    writeBatchMaxDelayMs: 10,
  })
  await ctx.plugin(SessionCheckpointPolicy)
  return path
}

async function readCheckpoint(id) {
  try {
    const value = JSON.parse(await readFile(defaultCheckpointPath(id), 'utf8'))
    if (value?.version !== 1 || value.logicalSessionId !== String(id)) return null
    return value
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeCheckpoint() {
  if (!agent || !ctx || !logicalSessionId) return
  await ctx.sessions.flush(agent.session)
  const path = defaultCheckpointPath(logicalSessionId)
  const value = {
    version: 1,
    logicalSessionId: String(logicalSessionId),
    sourceSessionId: String(sessionId),
    generation: checkpointGeneration,
    capturedThroughSeq: agent.session.events.length - 1,
    header: structuredClone(agent.session.header),
    surfaceEvents: currentSurfaceEvents(agent.session),
    updatedAtMs: Date.now(),
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  try {
    await rename(temporary, path)
  } catch (error) {
    try { await unlink(temporary) } catch {}
    throw error
  }
}

function queueCheckpoint() {
  checkpointChain = checkpointChain
    .then(() => writeCheckpoint())
    .catch(error => fail(null, new Error(`DSH surface checkpoint failed: ${error?.message ?? error}`)))
  return checkpointChain
}

function queueSessionMaterialized() {
  if (nativeSessionMaterialized || !nativeSessionSnapshot || !agent || !ctx) return
  checkpointChain = checkpointChain
    .then(async () => {
      if (nativeSessionMaterialized) return
      // A freshly-created DSH Session only has an in-memory header after
      // createAgent().  The first native turn/start is the commit boundary
      // that makes the ledger authoritative across Runtime replacement.
      await ctx.sessions.flush(agent.session)
      nativeSessionMaterialized = true
      emit({
        type: 'session-materialized',
        sessionId,
        snapshot: { ...nativeSessionSnapshot, materialized: true },
      })
    })
    .catch(error => fail(null, new Error(
      `DSH session materialization failed: ${error?.message ?? error}`,
    )))
}

async function readPersistedTail(command, id, fromSeq) {
  const reader = new Context()
  try {
    const path = persistencePathFor(command, id, id)
    await reader.plugin(SessionStore)
    await reader.plugin(SqliteSessionPersistence, { path, journalMode: 'wal' })
    return await reader.sessionPersistence.readFrom(SessionId(String(id)), fromSeq)
  } finally {
    await reader.fiber.dispose()
  }
}

function tailHasInterruptedTurn(events) {
  const open = new Set()
  for (const event of events ?? []) {
    if (event.type === 'turn/start') open.add(event.data?.turn)
    if (event.type === 'turn/end') open.delete(event.data?.turn)
  }
  return open.size > 0
}

async function prepareSurfaceGeneration(command, requestedSessionId) {
  const checkpoint = await readCheckpoint(logicalSessionId)
  if (!checkpoint || checkpoint.sourceSessionId !== String(requestedSessionId)) return null
  const persisted = await readPersistedTail(
    command,
    requestedSessionId,
    Number(checkpoint.capturedThroughSeq) + 1,
  )
  const tail = persisted.events ?? []
  const surface = advanceSurface(checkpoint.surfaceEvents, tail)
  const interrupted = tailHasInterruptedTurn(tail)
  checkpointGeneration = Number(checkpoint.generation ?? 0) + 1
  const nextSessionId = SessionId(`${logicalSessionId}.g${checkpointGeneration}`)
  return {
    sessionId: nextSessionId,
    seed: surfaceToSeed(surface, { interrupted }),
    interruptedTurns: interrupted ? 1 : 0,
  }
}

async function persistedSessionExists(id) {
  return (await ctx.sessionPersistence.list()).some(header => header.id === id)
}

async function initialize(command) {
  if (initialized) throw new Error('DSH worker is already initialized')
  const provider = String(command.provider ?? '').trim()
  const model = String(command.model ?? '').trim()
  const baseURL = String(command.baseURL ?? '').trim().replace(/\/$/, '')
  const apiProtocol = String(command.apiProtocol ?? 'openai-completions').trim()
  const cwd = String(command.cwd ?? process.cwd())
  if (!provider || !model || !baseURL) throw new Error('provider, model and baseURL are required')
  if (!process.env[API_KEY_ENV]) throw new Error(`${API_KEY_ENV} is not loaded`)
  providerInputModalities = normalizeDshInputModalities(command.inputModalities)
  const requestedSessionId = SessionId(String(command.sessionId))
  logicalSessionId = String(command.logicalSessionId ?? requestedSessionId)
  sessionId = requestedSessionId
  ctx = new Context()
  // Attachments belong to the stable logical Thread. Physical Runtime
  // generations are disposable and must not silently move the attachment
  // namespace on every cold resume.
  const dshHome = defaultDshHome(logicalSessionId)
  const capabilityBindings = Array.isArray(command.capabilities) ? command.capabilities : []
  await materializeCapabilitySkills(capabilityBindings, dshHome)
  await ctx.plugin(LocalAttachmentStore, dshHome ? { dshHome } : {})
  const attachedWorkspace = command.workspace?.transport === 'ssh' && command.workspace.host
  await ctx.plugin(attachedWorkspace ? SshSubprocessRuntime : LocalSubprocessRuntime,
    attachedWorkspace ? command.workspace : {})
  await ctx.plugin(LocalBashExecutor, { cwd })
  await ctx.plugin(AgentSpine, {
    // Capability Skills are materialized below this stable, per-Thread home.
    // AgentSpine must resolve the exact same home; otherwise its filesystem
    // provider silently scans the process user's default ~/.dsh/skills while
    // the capability files live in a different namespace.
    ...(dshHome ? { dshHome } : {}),
    workspaceContext: false,
    toolBash: {},
    toolJobs: {},
    goals: {},
    skills: { enabled: true },
  })
  registerCapabilityTools(capabilityBindings)
  if (capabilityBindings.length > 0) {
    const discovered = new Set((await ctx.skills.list({ cwd })).map(skill => skill.name))
    for (const binding of capabilityBindings) {
      const skillName = binding?.skill?.name
      if (skillName && !discovered.has(skillName)) {
        throw new Error(`capability skill ${JSON.stringify(skillName)} was not discovered from DSH_HOME`)
      }
      const toolName = binding?.tool?.name
      if (toolName && !ctx.tools.get(toolName)) {
        throw new Error(`capability tool ${JSON.stringify(toolName)} was not registered`)
      }
    }
  }
  await ctx.plugin(PiAi, {
    providers: {
      [provider]: {
        displayName: command.displayName ?? provider,
        apiKeyEnv: API_KEY_ENV,
        api: apiProtocol,
        baseURL,
        ...(command.compat && Object.keys(command.compat).length > 0
          ? { compat: command.compat }
          : {}),
        models: [{
          id: model,
          name: command.displayName ?? model,
          contextWindow: Number(command.contextWindow) || 262_144,
          maxTokens: Number(command.maxTokens) || 32_768,
          // Advertise the provider's real capability. DSH's LlmRuntime keeps
          // the canonical ledger provider-neutral, then applies
          // projectImagesForTextModel() at the final adapter boundary. This
          // preserves durable historical images while ensuring a text-only
          // provider receives explicit text placeholders instead of image
          // blocks. Current-turn images are rejected above this boundary by
          // dshContentFromAppInput().
          input: providerInputModalities,
          ...(command.reasoningEfforts ? { reasoningEfforts: command.reasoningEfforts } : {}),
        }],
      },
    },
  })
  await new Promise(resolve => setTimeout(resolve, 25))
  await ctx.subprocess.resolveExecutable('bash')

  let generationResume = null
  if (command.expectExistingSession) {
    try {
      generationResume = await prepareSurfaceGeneration(command, requestedSessionId)
    } catch (error) {
      console.warn(
        `[dsh-engine] surface generation restore unavailable session=${requestedSessionId}: ` +
        `${error?.message ?? error}`,
      )
    }
  }
  if (generationResume) sessionId = generationResume.sessionId
  const persistencePath = await installPersistence(command, sessionId, requestedSessionId)
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return
    if (event.type === 'turn/start' && pendingClientTurnId !== null) {
      activeClientTurnId = pendingClientTurnId
      pendingClientTurnId = null
      queueSessionMaterialized()
    }
    const clientTurnId = activeClientTurnId
    emit({ type: 'session-event', sessionId, clientTurnId, event })
    if (event.type === 'turn/end') {
      activeClientTurnId = null
      queueCheckpoint()
    }
  })
  ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject !== agent) return
    const clientTurnId = activeClientTurnId ?? pendingClientTurnId
    emit({ type: 'agent-status', sessionId, clientTurnId, status })
    if (status === 'idle' && activeClientTurnId === null && pendingClientTurnId !== null) {
      emit({
        type: 'turn-rejected',
        clientTurnId: pendingClientTurnId,
        message: 'DSH returned to idle before publishing turn/start',
      })
      pendingClientTurnId = null
    }
  })
  let provenance = 'native'
  const stored = await persistedSessionExists(sessionId)
  if (!stored && command.expectExistingSession && !generationResume) {
    throw new Error(
      `authoritative DSH session ledger is missing for ${sessionId}; ` +
      'refusing to replace it with an empty transcript',
    )
  }
  if (generationResume) {
    agentHandle = await ctx.agentLoop.createAgent(ctx, {
      sessionId,
      seed: generationResume.seed,
      meta: { cwd },
      agentOptions: { provider, model },
    })
    provenance = 'dsh-surface-generation-resume'
  } else if (stored) {
    agentHandle = await ctx.agentLoop.resumeWith(ctx, ctx.sessionPersistence, {
      resumeSessionId: sessionId,
      agentOptions: { provider, model },
    })
    if (provenance === 'native') provenance = 'dsh-sqlite-resume'
  } else {
    agentHandle = await ctx.agentLoop.createAgent(ctx, {
      sessionId,
      meta: { cwd },
      agentOptions: { provider, model },
    })
  }
  agent = agentHandle.agent
  const interruptedTurns = agent.session.events.filter(event => (
    event.type === 'turn/end' && event.data?.reason?.kind === 'interrupted'
  )).length
  await writeCheckpoint()
  nativeSessionMaterialized = stored || generationResume !== null
  nativeSessionSnapshot = {
    sessionId,
    header: structuredClone(agent.session.header),
    provenance,
    persistencePath,
    materialized: nativeSessionMaterialized,
    recovery: { interruptedTurns },
  }
  initialized = true
  emit({
    type: 'initialized',
    requestId: command.requestId ?? null,
    sessionId,
    snapshot: nativeSessionSnapshot,
  })
}

async function startTurn(command) {
  if (!initialized || !agent) throw new Error('DSH worker is not initialized')
  if (activeClientTurnId !== null || pendingClientTurnId !== null) {
    throw new Error('DSH worker already has an active or dispatched turn')
  }
  const content = await dshContentFromAppInput(command.input, ctx.attachments, {
    inputModalities: providerInputModalities,
  })
  if (content.length === 0) throw new Error('DSH turn requires at least one text or image input')
  pendingClientTurnId = String(command.turnId)
  emit({ type: 'turn-dispatched', requestId: command.requestId ?? null, turnId: pendingClientTurnId })
  agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
}

async function handle(command) {
  switch (command?.type) {
    case 'initialize':
      await initialize(command)
      return
    case 'turn/start':
      await startTurn(command)
      return
    case 'turn/steer': {
      if (!agent) throw new Error('DSH worker is not initialized')
      const content = await dshContentFromAppInput(command.input, ctx.attachments, {
        inputModalities: providerInputModalities,
      })
      if (content.length === 0) throw new Error('DSH steering requires text or image input')
      agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
      emit({ type: 'steer-accepted', requestId: command.requestId ?? null })
      return
    }
    case 'turn/interrupt':
      if (!agent) throw new Error('DSH worker is not initialized')
      agent.cancel({ kind: 'user' })
      emit({ type: 'interrupt-accepted', requestId: command.requestId ?? null })
      return
    case 'capability-response': {
      const pending = pendingCapabilityCalls.get(String(command.requestId ?? ''))
      if (!pending) return
      pendingCapabilityCalls.delete(String(command.requestId))
      if (command.error) pending.reject(new Error(String(command.error)))
      else pending.resolve(command.result)
      return
    }
    case 'dispose':
      for (const pending of pendingCapabilityCalls.values()) {
        pending.reject(new Error('DSH worker disposed during capability call'))
      }
      pendingCapabilityCalls.clear()
      await checkpointChain
      if (agentHandle) await agentHandle.dispose()
      agentHandle = null
      agent = null
      if (ctx) await ctx.fiber.dispose()
      emit({ type: 'disposed', requestId: command.requestId ?? null })
      process.exit(0)
      return
    default:
      throw new Error(`unknown DSH worker command ${JSON.stringify(command?.type)}`)
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  commandChain = commandChain
    .then(() => handle(JSON.parse(line)))
    .catch(error => fail(null, error))
})
lines.on('close', async () => {
  try {
    await commandChain
    await checkpointChain
    if (agentHandle) await agentHandle.dispose()
    if (ctx) await ctx.fiber.dispose()
  } finally {
    process.exit(0)
  }
})

process.on('uncaughtException', error => {
  fail(null, error)
  process.exit(1)
})
process.on('unhandledRejection', error => {
  fail(null, error)
  process.exit(1)
})
