#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceSshClient } from './workspace-ssh-client.mjs'
import { Context } from '@deepseek-ai/cordis'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import SshSubprocessRuntime from './dsh-subprocess-ssh.mjs'

const binary = process.env.HYPERNODE_WORKSPACE_AGENT_BIN ?? '/tmp/hypernode-workspace-agent'
const root = await mkdtemp(join(tmpdir(), 'hypernode-workspace-agent-'))
const database = join(root, 'agent.sqlite')
const port = Number(process.env.HYPERNODE_WORKSPACE_AGENT_PORT ?? 2299)
await mkdir(join(root, 'projects'), { recursive: true })
const child = spawn(binary, [
  'workspace-agent', '--listen', `127.0.0.1:${port}`,
  '--root', root, '--db', database,
  '--policy', new URL('../policy/workspace-agent.js', import.meta.url).pathname,
], { stdio: ['ignore', 'pipe', 'pipe'] })

let logs = ''
child.stdout.on('data', chunk => { logs += chunk })
child.stderr.on('data', chunk => { logs += chunk })

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value))
  const frame = Buffer.allocUnsafe(payload.length + 4)
  frame.writeUInt32BE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

async function verifyWorkspaceWatchFastPath(client) {
  const watched = join(root, 'watched')
  await mkdir(watched, { recursive: true })
  await new Promise((resolve, reject) => {
    client.client.exec('@hypernode workspace-stdio hypernode-fs@v1', (error, stream) => {
      if (error) return reject(error)
      let buffer = Buffer.alloc(0)
      let changed = false
      const timeout = setTimeout(() => reject(new Error('workspace watch fast path timed out')), 5_000)
      const finish = callback => value => {
        clearTimeout(timeout)
        try { stream.close() } catch {}
        callback(value)
      }
      stream.stderr.on('data', chunk => { logs += chunk })
      stream.on('error', finish(reject))
      stream.on('data', async chunk => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 4) {
          const size = buffer.readUInt32BE(0)
          if (buffer.length < size + 4) break
          const message = JSON.parse(buffer.subarray(4, size + 4).toString())
          buffer = buffer.subarray(size + 4)
          if (message.type === 'error') return finish(reject)(new Error(message.message))
          if (message.type === 'ready' && !changed) {
            changed = true
            // Prove that a second native SSH channel can run while the watch
            // channel remains open; there is no application-level mux.
            const parallel = await client.exec('printf multiplex-ok')
            if (parallel.stdout.trim() !== 'multiplex-ok') {
              return finish(reject)(new Error(`parallel channel failed: ${JSON.stringify(parallel)}`))
            }
            await writeFile(join(watched, 'changed.txt'), 'changed')
          }
          if (message.type === 'event' && message.path === '/workspace/watched/changed.txt') {
            if (message.filename !== 'changed.txt') {
              return finish(reject)(new Error(`bad watch filename: ${JSON.stringify(message)}`))
            }
            return finish(resolve)()
          }
        }
      })
      stream.write(encodeFrame({ op: 'watch', path: '/workspace/watched', recursive: true }))
    })
  })
}

async function verifyInteractiveTerminal(client) {
  const output = await new Promise((resolve, reject) => {
    client.client.shell({ term: 'xterm-256color', cols: 96, rows: 32 }, (error, stream) => {
      if (error) return reject(error)
      let value = ''
      const timeout = setTimeout(() => {
        try { stream.close() } catch {}
        reject(new Error(`workspace interactive terminal timed out: ${JSON.stringify(value)}\n${logs}`))
      }, 5_000)
      stream.on('data', chunk => { value += chunk.toString() })
      stream.stderr.on('data', chunk => { value += chunk.toString() })
      stream.on('error', reject)
      stream.on('close', () => {
        clearTimeout(timeout)
        resolve(value)
      })
      stream.setWindow(40, 120, 0, 0)
      stream.write('printf "workspace-terminal-ok\\n"; pwd; exit\n')
    })
  })
  if (!output.includes('workspace-terminal-ok') || !output.includes(join(root, 'projects'))) {
    throw new Error(`unexpected workspace terminal output: ${JSON.stringify(output)}`)
  }
}

try {
  const client = new WorkspaceSshClient({ host: '127.0.0.1', port })
  let outcome = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      outcome = await client.exec('printf agent-js-client-ok; pwd')
      break
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  if (!outcome) throw new Error(`workspace agent did not become ready\n${logs}`)
  if (outcome.exitCode !== 0 || !outcome.stdout.includes('agent-js-client-ok') || !outcome.stdout.includes(root)) {
    throw new Error(`unexpected workspace result: ${JSON.stringify(outcome)}`)
  }
  await verifyWorkspaceWatchFastPath(client)
  await verifyInteractiveTerminal(client)
  await client.detach()
  const ctx = new Context()
  await ctx.plugin(SshSubprocessRuntime, { host: '127.0.0.1', port, username: 'root' })
  await ctx.plugin(LocalBashExecutor, { cwd: root })
  await new Promise(resolve => setTimeout(resolve, 25))
  const shellResult = await ctx.shell.run(ctx.shell.resolve({
    command: 'printf "dsh-ssh-tool-ok\\n"; pwd',
  }))
  if (shellResult.exitCode !== 0 || !shellResult.stdout.text.includes('dsh-ssh-tool-ok') || !shellResult.stdout.text.includes(root)) {
    throw new Error(`unexpected DSH SSH shell result: ${JSON.stringify(shellResult)}`)
  }
  await ctx.fiber.dispose()
  console.log(JSON.stringify({
    ok: true,
    transport: 'vssh',
    client: 'ssh2-js',
    dshSubprocess: true,
    workspaceWatchFastPath: true,
    nativeChannelMultiplexing: true,
    interactiveTerminal: true,
    root,
  }))
} finally {
  child.kill('SIGTERM')
  await new Promise(resolve => child.once('exit', resolve))
  await rm(root, { recursive: true, force: true })
}
