/**
 * Versioned identity of the OpenCraft agent bridge contract.
 *
 * The wire protocol version bumps only for breaking changes to the envelope;
 * additive capabilities ride capability tolerance. The grammar range lets the
 * semantic-delta vocabulary evolve without a protocol bump. The schema version
 * is stamped into every recording manifest and assembler checkpoint, so a
 * replay refuses a recording it cannot honestly reproduce.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;
export const BRIDGE_SCHEMA_VERSION = 1;
export const BRIDGE_SCHEMA_ID = "opencraft.agent-bridge/1";

export interface GrammarRange {
  readonly min: number;
  readonly max: number;
}

/** The single grammar this first assembler speaks. */
export const BRIDGE_GRAMMAR_RANGE: GrammarRange = Object.freeze({ min: 1, max: 1 });

/** Highest common grammar version, or null when the two sides share none. */
export function negotiateGrammar(host: GrammarRange, bridge: GrammarRange): number | null {
  const high = Math.min(host.max, bridge.max);
  const low = Math.max(host.min, bridge.min);
  return high >= low ? high : null;
}
