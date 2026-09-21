import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { PassThrough } from 'node:stream'
import { WorkspaceSshClient, shellQuote } from './workspace-ssh-client.mjs'

let processSequence = 0

export function normalizePathMappings(value) {
  if (!Array.isArray(value)) return []
  return value.flatMap(mapping => {
    const publicPath = String(mapping?.publicPath ?? '').replace(/\/+$/, '')
    const privatePath = String(mapping?.privatePath ?? '').replace(/\/+$/, '')
    if (!publicPath.startsWith('/') || !privatePath.startsWith('/') || publicPath === privatePath) return []
    return [{ publicPath, privatePath }]
  }).sort((left, right) => right.publicPath.length - left.publicPath.length)
}

function replacePath(value, source, destination) {
  let remaining = String(value)
  let result = ''
  for (;;) {
    const index = remaining.indexOf(source)
    if (index < 0) return `${result}${remaining}`
    const suffix = remaining[index + source.length]
    result += remaining.slice(0, index)
    if (suffix === undefined || suffix === '/' || !/[A-Za-z0-9._-]/.test(suffix)) {
      result += destination
    } else {
      result += source
    }
    remaining = remaining.slice(index + source.length)
  }
}

export function mapPublicWorkspacePaths(value, mappings) {
  let result = String(value)
  for (const mapping of mappings) result = replacePath(result, mapping.publicPath, mapping.privatePath)
  return result
}

export function projectPrivateWorkspacePaths(value, mappings) {
  let result = String(value)
  for (const mapping of mappings) result = replacePath(result, mapping.privatePath, mapping.publicPath)
  return result
}

class StreamingPathProjector {
  constructor(mappings) {
    this.mappings = mappings
    this.pending = ''
  }

  push(chunk) {
    const value = `${this.pending}${String(chunk)}`
    let retained = 0
    for (const { privatePath } of this.mappings) {
      const maximum = Math.min(value.length, privatePath.length - 1)
      for (let length = maximum; length > retained; length -= 1) {
        if (privatePath.startsWith(value.slice(-length))) {
          retained = length
          break
        }
      }
    }
    const ready = retained > 0 ? value.slice(0, -retained) : value
    this.pending = retained > 0 ? value.slice(-retained) : ''
    return projectPrivateWorkspacePaths(ready, this.mappings)
  }

  flush() {
    const value = projectPrivateWorkspacePaths(this.pending, this.mappings)
    this.pending = ''
    return value
  }
}

function executableCommand(argv, mappings) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('SSH subprocess requires argv')
  return argv.map(value => shellQuote(mapPublicWorkspacePaths(value, mappings))).join(' ')
}

function outputCollector(mode) {
  if (!mode || typeof mode !== 'object') return null
  const maxBytes = Math.max(1, Number(mode.maxBytes) || 1)
  let retained = Buffer.alloc(0)
  let totalBytes = 0
  return {
    append(chunk) {
      const bytes = Buffer.from(String(chunk))
      totalBytes += bytes.length
      retained = Buffer.concat([retained, bytes])
      if (retained.length > maxBytes) retained = retained.subarray(retained.length - maxBytes)
    },
    readFrom(fromByte) {
      const requested = Math.max(0, Number(fromByte) || 0)
      const firstRetained = totalBytes - retained.length
      const start = Math.max(0, requested - firstRetained)
      return {
        text: retained.subarray(start).toString('utf8'),
        nextOffset: totalBytes,
        lossy: requested < firstRetained,
      }
    },
  }
}

/** DSH subprocess capability implemented by one attached vSSH workspace. */
export class SshSubprocessRuntime extends SubprocessRuntime {
  constructor(ctx, config) {
    super(ctx)
    this.client = new WorkspaceSshClient(config)
    this.pathMappings = normalizePathMappings(config.pathMappings)
    this.handles = new Set()
    ctx.effect(() => () => this.dispose())
  }

  async resolveExecutable(command, env = {}, signal) {
    const name = String(command)
    const probe = name.startsWith('/')
      ? `test -x ${shellQuote(name)} && printf %s ${shellQuote(name)}`
      : `command -v -- ${shellQuote(name)}`
    const result = await this.client.exec(probe, { env, signal })
    const resolved = result.stdout.trim()
    if (result.exitCode !== 0 || !resolved) throw new Error(`executable not found in SSH workspace: ${name}`)
    return resolved
  }

  spawn(spec) {
    const stdoutCollector = outputCollector(spec.stdio.stdout)
    const stderrCollector = outputCollector(spec.stdio.stderr)
    const stdout = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    const stderr = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined
    const stdin = spec.stdio.stdin === 'pipe' ? new PassThrough() : undefined
    const stdoutProjector = new StreamingPathProjector(this.pathMappings)
    const stderrProjector = new StreamingPathProjector(this.pathMappings)
    const controller = new AbortController()
    const abort = () => controller.abort(spec.signal?.reason ?? new Error('SSH subprocess aborted'))
    spec.signal?.addEventListener?.('abort', abort, { once: true })
    const handle = {
      pid: ++processSequence,
      stdin,
      stdout,
      stderr,
      collected: {
        ...(stdoutCollector ? { stdout: stdoutCollector } : {}),
        ...(stderrCollector ? { stderr: stderrCollector } : {}),
      },
      terminate: () => controller.abort(new Error('SSH subprocess terminated')),
      waitForExit: async signal => {
        if (!signal) {
          await handle.done.catch(() => {})
          return true
        }
        return Promise.race([
          handle.done.then(() => true, () => true),
          new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true })),
        ])
      },
      done: null,
    }
    this.handles.add(handle)
    const emitStdout = chunk => {
      if (!chunk) return
      stdoutCollector?.append(chunk)
      stdout?.write(chunk)
      if (spec.stdio.stdout === 'inherit') process.stdout.write(chunk)
    }
    const emitStderr = chunk => {
      if (!chunk) return
      stderrCollector?.append(chunk)
      stderr?.write(chunk)
      if (spec.stdio.stderr === 'inherit') process.stderr.write(chunk)
    }
    handle.done = this.client.exec(executableCommand(spec.argv, this.pathMappings), {
      cwd: typeof spec.cwd === 'string'
        ? mapPublicWorkspacePaths(spec.cwd, this.pathMappings)
        : spec.cwd,
      env: Object.fromEntries(Object.entries(spec.env ?? {}).map(([key, value]) => [
        key, mapPublicWorkspacePaths(value, this.pathMappings),
      ])),
      signal: controller.signal,
      ...(typeof spec.stdio.stdin === 'object'
        ? { stdin: spec.stdio.stdin.data }
        : spec.stdio.stdin === 'ignore' ? { stdin: null } : {}),
      onChannel: channel => stdin?.pipe(channel),
      onStdout: chunk => emitStdout(stdoutProjector.push(chunk)),
      onStderr: chunk => emitStderr(stderrProjector.push(chunk)),
    }).then(result => ({
      exitCode: result.signal ? null : result.exitCode,
      signal: result.signal ? String(result.signal).toUpperCase() : null,
    })).finally(() => {
      emitStdout(stdoutProjector.flush())
      emitStderr(stderrProjector.flush())
      stdout?.end()
      stderr?.end()
      spec.signal?.removeEventListener?.('abort', abort)
      this.handles.delete(handle)
    })
    return handle
  }

  async spawnTerminal() {
    throw new Error('terminal subprocesses are not enabled on the DSH SSH workspace adapter')
  }

  async dispose() {
    for (const handle of this.handles) handle.terminate()
    await Promise.allSettled([...this.handles].map(handle => handle.done))
    await this.client.detach()
  }
}

export default SshSubprocessRuntime
