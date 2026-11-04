/** Only allowlisted diagnostics cross the capability boundary. Never attach raw
 * transport errors, headers, arguments or credential resolver values. */
export type CapabilityErrorCode = 'capability_not_authorized' | 'capability_catalog_unavailable'
  | 'capability_catalog_invalid' | 'capability_invalid_arguments' | 'capability_upstream_unavailable'
  | 'capability_upstream_rejected' | 'capability_cancelled' | 'capability_outcome_unknown';
export type CapabilityPhase = 'authorization' | 'catalog' | 'connection' | 'invocation';
export type CapabilityOutcome = 'not_dispatched' | 'unknown';
export class CapabilityError extends Error {
  constructor(readonly code: CapabilityErrorCode, readonly phase: CapabilityPhase,
    readonly outcome: CapabilityOutcome = 'not_dispatched', readonly upstreamStatus?: number) {
    super(code + (code === 'capability_catalog_invalid' ? ' (invalid declaration or capability name conflict)' : '') + (outcome === 'unknown' ? '; inspect the original operation before retrying; an external effect may have occurred.' : '; external tool invocation was not dispatched.'));
    this.name = 'CapabilityError';
  }
}
