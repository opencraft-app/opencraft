export function createSurfaceCheckpoint(isSurfaceEvent) {


function clone(value) {
  return value == null ? value : structuredClone(value)
}

function callIdFromResult(event) {
  return String(event?.data?.message?.source?.callId ?? '')
}

function toolCallsFromAssistant(event) {
  return (event?.data?.message?.content ?? []).filter(block => block?.type === 'tool-call')
}

/**
 * Apply an authoritative event-ledger tail to a previously captured current
 * surface.  The immutable ledger remains the source of truth; this function
 * only advances its model-visible projection from a durable watermark.
 */
function advanceSurface(checkpointSurface, tailEvents) {
  const nodes = clone(checkpointSurface ?? [])
  for (const event of tailEvents ?? []) {
    if (!isSurfaceEvent(event)) continue
    if (event.surfaceOp === 'append') {
      nodes.push(clone(event))
      continue
    }
    const start = Number(event.surfaceOp?.start)
    const end = Number(event.surfaceOp?.end)
    const startIndex = nodes.findIndex(node => node.seq === start)
    const endIndex = nodes.findIndex(node => node.seq === end)
    if (startIndex < 0 || endIndex < startIndex) {
      throw new Error(
        `surface checkpoint cannot apply replacement ${event.seq}: ` +
        `range ${start}..${end} is not present`,
      )
    }
    nodes.splice(startIndex, endIndex - startIndex + 1, clone(event))
  }
  return nodes
}

/**
 * Convert the exact current model surface into a small, relationally valid
 * DSH seed.  Tool calls are reconstructed from assistant content because they
 * are deliberately absent from the three-type surface projection.
 */
function surfaceToSeed(surfaceEvents, { interrupted = false } = {}) {
  const seed = []
  const startedAt = Date.now()
  let turn = 0
  let step = 0
  let turnOpen = false
  let stepOpen = false
  let assistantSeen = false
  let pendingCalls = new Map()

  const append = (type, data, options = {}) => {
    const event = {
      type,
      seq: seed.length,
      time: startedAt + seed.length,
      data: clone(data),
      ...options,
    }
    seed.push(event)
    return event
  }
  const openTurn = () => {
    turn += 1
    step = 0
    turnOpen = true
    assistantSeen = false
    append('turn/start', { turn })
  }
  const openStep = () => {
    if (!turnOpen) openTurn()
    step += 1
    stepOpen = true
    pendingCalls = new Map()
    append('step/start', { turn, step })
  }
  const closeStep = () => {
    if (!stepOpen) return
    append('step/end', { turn, step })
    stepOpen = false
    pendingCalls = new Map()
  }
  const closeTurn = (reason = { kind: 'completed' }) => {
    if (!turnOpen) return
    closeStep()
    append('turn/end', { turn, reason })
    turnOpen = false
    assistantSeen = false
  }

  for (const source of surfaceEvents ?? []) {
    if (!isSurfaceEvent(source)) continue
    if (source.type === 'user/message') {
      if (assistantSeen) closeTurn()
      if (!turnOpen) openTurn()
      if (!stepOpen) openStep()
      append('user/message', source.data, { surfaceOp: 'append' })
      continue
    }
    if (source.type === 'assistant/message') {
      if (!turnOpen) openTurn()
      if (assistantSeen) {
        closeStep()
        openStep()
      } else if (!stepOpen) {
        openStep()
      }
      const assistant = append('assistant/message', {
        ...source.data,
        turn,
        step,
      }, { surfaceOp: 'append' })
      assistantSeen = true
      for (const block of toolCallsFromAssistant(source)) {
        const call = append('tool/call', {
          turn,
          step,
          callId: block.id,
          name: block.name,
          arguments: block.arguments,
        })
        pendingCalls.set(String(block.id), call.seq)
      }
      // Retain the event for parity with the append ordering even though its
      // seq is not itself cited by tool results.
      void assistant
      continue
    }
    if (source.type === 'tool/result') {
      if (!turnOpen) openTurn()
      if (!stepOpen) openStep()
      const callId = callIdFromResult(source)
      let callSeq = pendingCalls.get(callId)
      if (callSeq === undefined) {
        const call = append('tool/call', {
          turn,
          step,
          callId,
          name: 'restored_tool',
          arguments: {},
        })
        callSeq = call.seq
        pendingCalls.set(callId, callSeq)
      }
      append('tool/result', {
        ...source.data,
        turn,
        step,
      }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
      pendingCalls.delete(callId)
    }
  }

  closeTurn(interrupted ? { kind: 'interrupted' } : { kind: 'completed' })
  return seed
}

function currentSurfaceEvents(session) {
  return session.surface.nodes.map(seq => clone(session.events[seq]))
}

return { advanceSurface, surfaceToSeed, currentSurfaceEvents };
}
