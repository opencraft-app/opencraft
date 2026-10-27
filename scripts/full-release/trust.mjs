// Distribution composition bakes this literal into fixed bootstrap entrypoints.
// Downloaded packages never contribute keys to this trust root.
export const fullReleaseTrust = JSON.parse(process.env.OPENCRAFT_FULL_RELEASE_TRUST_JSON || 'null');
