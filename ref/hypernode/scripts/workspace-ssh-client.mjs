import { Client } from 'ssh2'

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

function commandInWorkspace(command, cwd) {
  if (!cwd || cwd === '/') return String(command)
  return `cd -- ${shellQuote(cwd)} && ${String(command)}`
}

/**
 * Persistent JS SSH transport for one attached workspace view.
 *
 * Thread and engine identity intentionally do not live here. The caller owns
 * the attachment lifecycle and may replace this transport without changing
 * either identity.
 */
export class WorkspaceSshClient {
  constructor({ host, port = 2222, username = 'root', readyTimeout = 10_000 }) {
    if (!host) throw new Error('workspace SSH host is required')
    this.options = { host, port, username, readyTimeout }
    this.client = null
    this.connecting = null
  }

  async attach() {
    if (this.client) return this
    if (this.connecting) return this.connecting
    this.connecting = new Promise((resolve, reject) => {
      const client = new Client()
      const failed = error => {
        client.removeAllListeners()
        client.end()
        this.connecting = null
        reject(error)
      }
      client.once('ready', () => {
        client.removeListener('error', failed)
        client.on('error', error => { this.lastError = error })
        client.on('close', () => { if (this.client === client) this.client = null })
        this.client = client
        this.connecting = null
        resolve(this)
      })
      client.once('error', failed)
      // With no password/key ssh2 starts with the RFC 4252 `none` method,
      // which the private workspace agent accepts in the current trust model.
      client.connect({
        ...this.options,
        hostVerifier: () => true,
        keepaliveInterval: 5_000,
        keepaliveCountMax: 3,
      })
    })
    return this.connecting
  }

  async exec(command, {
    cwd = '/',
    env = {},
    signal,
    stdin,
    onStdout,
    onStderr,
    onChannel,
  } = {}) {
    await this.attach()
    if (signal?.aborted) throw signal.reason ?? new Error('workspace command aborted')
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        signal?.removeEventListener?.('abort', abort)
        callback(value)
      }
      let channel = null
      const abort = () => {
        try { channel?.signal?.('TERM') } catch {}
        try { channel?.close?.() } catch {}
        finish(reject, signal.reason ?? new Error('workspace command aborted'))
      }
      signal?.addEventListener?.('abort', abort, { once: true })
      this.client.exec(commandInWorkspace(command, cwd), { env }, (error, stream) => {
        if (error) return finish(reject, error)
        channel = stream
        onChannel?.(stream)
        stream.setEncoding('utf8')
        stream.stderr.setEncoding('utf8')
        stream.on('data', chunk => {
          stdout += chunk
          onStdout?.(chunk)
        })
        stream.stderr.on('data', chunk => {
          stderr += chunk
          onStderr?.(chunk)
        })
        stream.once('error', streamError => finish(reject, streamError))
        stream.once('close', (code, exitSignal) => finish(resolve, {
          stdout,
          stderr,
          exitCode: Number.isInteger(code) ? code : exitSignal ? 128 : 0,
          signal: exitSignal ?? null,
        }))
        if (stdin !== undefined) stream.end(stdin === null ? '' : String(stdin))
      })
    })
  }

  async detach() {
    const connecting = this.connecting
    if (connecting) {
      try { await connecting } catch {}
    }
    const client = this.client
    this.client = null
    if (!client) return
    await new Promise(resolve => {
      client.once('close', resolve)
      client.end()
      setTimeout(resolve, 1_000).unref?.()
    })
  }
}
