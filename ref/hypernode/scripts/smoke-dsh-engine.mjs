#!/usr/bin/env node

import { Context } from '@deepseek-ai/cordis'
import * as AgentSpine from '@deepseek-ai/dsh-agent-spine-demo'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'

class MockAdapter extends LlmAdapter {
  async * stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'DSH DIRECT OK' }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'DSH DIRECT OK' },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const ctx = new Context()
try {
  await ctx.plugin(AgentSpine, {
    workspaceContext: false,
    toolBash: false,
    toolJobs: {},
    goals: {},
    skills: { enabled: true },
  })
  await new Promise(resolve => setTimeout(resolve, 25))
  ctx.llm.registerAdapter(['hypernode-direct-smoke'], new MockAdapter())

  const sessionId = SessionId(`hypernode-direct-smoke-${crypto.randomUUID()}`)
  const agent = ctx.agentLoop.create(sessionId, {
    provider: 'hypernode-direct-smoke',
    model: 'hypernode-direct-smoke',
  }, { cwd: process.cwd() })
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'smoke' }],
    source: { kind: 'user' },
  }))
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose()
      reject(new Error('DSH direct turn timed out'))
    }, 10_000)
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      clearTimeout(timer)
      dispose()
      resolve()
    })
  })

  const assistant = agent.session.events.findLast(event => event.type === 'assistant/message')
  const text = assistant?.data?.message?.content
    ?.filter(block => block.type === 'text')
    .map(block => block.text)
    .join('') ?? ''
  if (text !== 'DSH DIRECT OK') {
    throw new Error(`unexpected assistant text: ${JSON.stringify(text)} event=${JSON.stringify(assistant)}`)
  }
  const types = agent.session.events.map(event => event.type)
  for (const required of ['turn/start', 'user/message', 'assistant/message', 'turn/end']) {
    if (!types.includes(required)) throw new Error(`missing DSH event ${required}`)
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    sessionId,
    text,
    eventCount: types.length,
    eventTypes: types,
  }) + '\n')
} finally {
  await ctx.fiber.dispose()
}
