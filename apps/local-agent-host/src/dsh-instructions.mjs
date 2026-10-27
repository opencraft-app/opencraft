const EVENT = "opencraft/instructions";
const fields = ["baseInstructions", "developerInstructions"];
const registrations = new WeakMap();

/** rc.2 exposes its accepted event vocabulary but has no plugin registration
 * method yet. Register only our owned event, retaining native refusal of every
 * other unknown type. Reference counts cover multiple composition owners.
 */
export function registerInstructionEvents(ctx, knownTypes) {
  ctx.effect(() => {
    const entry = registrations.get(knownTypes) ?? { count: 0, existing: knownTypes.has(EVENT) };
    entry.count++;
    registrations.set(knownTypes, entry);
    knownTypes.add(EVENT);
    return () => {
      if (--entry.count === 0) {
        if (!entry.existing) knownTypes.delete(EVENT);
        registrations.delete(knownTypes);
      }
    };
  });
}

/** Omitted/null RPC fields retain the saved choice; an empty string clears it.
 * Native Session metadata/events are the only durable instruction state.
 */
export function instructionOverrides(input) {
  const result = {};
  for (const field of fields) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new TypeError(`${field} must be a string or null`);
    result[field] = value;
  }
  return result;
}

export function sessionInstructions(session) {
  for (let i = session.events.length - 1; i >= 0; i--) {
    if (session.events[i].type === EVENT) return instructionOverrides(session.events[i].data);
  }
  return instructionOverrides(session.header.opencraftInstructions ?? {});
}

export function hasSessionInstructions(session) {
  return session.header.opencraftInstructions !== undefined || session.events.some(event => event.type === EVENT);
}

export function saveInstructions(session, input) {
  const previous = sessionInstructions(session);
  const next = { ...previous, ...instructionOverrides(input) };
  if (fields.some(field => previous[field] !== next[field])) session.append(EVENT, next);
  return next;
}

/** Scoped sections shadow the preset's persona rather than duplicating it.
 * Tools, dynamic repository context and harness sections retain native owners.
 */
export function mountInstructions(child, input, { PERSONA_SECTION, PERSONA_ORDER }) {
  const disposers = [];
  const literal = (name, order, text, variable) => {
    // RPC text is literal, not a native {{variable}} template. Interpolation
    // substitutes this value once and never scans the supplied text again.
    disposers.push(child.systemPrompt.variable(variable, () => text));
    disposers.push(child.systemPrompt.section({ name, order, text: `{{${variable}}}` }));
  };
  if (input.baseInstructions !== undefined) literal(PERSONA_SECTION, PERSONA_ORDER,
    input.baseInstructions, "opencraft_base_instructions");
  if (input.developerInstructions) literal("opencraft:developer-instructions", 90,
    input.developerInstructions, "opencraft_developer_instructions");
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}

export function createInstructionController(promptSlots) {
  const mounts = new Map();
  const apply = (child, instructions) => {
    const id = String(child.agent.session.id);
    mounts.get(id)?.dispose();
    mounts.set(id, { child, dispose: mountInstructions(child, instructions, promptSlots) });
  };
  return {
    setup(child, input) {
      const id = String(child.agent.session.id);
      child.effect(() => () => mounts.delete(id));
      const overrides = { ...(!hasSessionInstructions(child.agent.session) ? instructionOverrides(input.legacyInstructions ?? {}) : {}),
        ...instructionOverrides(input) };
      apply(child, saveInstructions(child.agent.session, overrides));
    },
    ensure(agent, input) {
      const mounted = mounts.get(String(agent.session.id));
      // The native Web API can load an Agent before the bridge activates it.
      // Borrow its existing scope; never recreate the Agent or its preset.
      if (!mounted) { this.setup(agent.ctx, input); return true; }
      if (!Object.keys(instructionOverrides(input)).length) return false;
      apply(mounted.child, saveInstructions(agent.session, input));
      return true;
    },
  };
}
