import ssh2 from 'ssh2';

/** ssh2's Ed25519 key generator occasionally strips a leading zero byte from
 * the public key (about 1/256 runs), producing a key its own parser rejects.
 * Retry until the pair is a valid OpenSSH key so ingress tests exercise the
 * ingress, not the key generator. */
export function generateEd25519KeyPair() {
  for (let attempt = 0; attempt < 64; attempt++) {
    const pair = ssh2.utils.generateKeyPairSync('ed25519');
    if (!(ssh2.utils.parseKey(pair.private) instanceof Error)) return pair;
  }
  throw new Error('ssh2 did not generate a valid Ed25519 key pair after 64 attempts');
}
