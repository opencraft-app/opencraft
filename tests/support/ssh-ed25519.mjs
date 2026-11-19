import { generateKeyPairSync, randomBytes } from 'node:crypto';

const KEY_TYPE = Buffer.from('ssh-ed25519');

const uint32 = value => Buffer.from([value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
const sshString = value => Buffer.concat([uint32(value.length), value]);

function rawEd25519Key() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  if (typeof jwk.d !== 'string' || typeof jwk.x !== 'string') throw new Error('Node did not export an Ed25519 JWK');
  const seed = Buffer.from(jwk.d, 'base64url');
  const publicKey = Buffer.from(jwk.x, 'base64url');
  if (seed.length !== 32 || publicKey.length !== 32) throw new Error('Node exported an unexpected Ed25519 key size');
  return { seed, publicKey };
}

function openSshPrivateKey(seed, publicKey) {
  const publicBlob = Buffer.concat([sshString(KEY_TYPE), sshString(publicKey)]);
  const check = randomBytes(4).readUInt32BE(0);
  const body = Buffer.concat([
    uint32(check), uint32(check),
    sshString(KEY_TYPE), sshString(publicKey), sshString(Buffer.concat([seed, publicKey])),
    sshString(Buffer.alloc(0)),
  ]);
  const padding = (8 - (body.length % 8)) % 8;
  const padded = Buffer.concat([body, Buffer.from(Array.from({ length: padding }, (_, index) => index + 1))]);
  const container = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString(Buffer.from('none')), sshString(Buffer.from('none')), sshString(Buffer.alloc(0)),
    uint32(1), sshString(publicBlob), sshString(padded),
  ]);
  const base64 = container.toString('base64').match(/.{1,70}/g)?.join('\n') ?? '';
  return {
    private: `-----BEGIN OPENSSH PRIVATE KEY-----\n${base64}\n-----END OPENSSH PRIVATE KEY-----\n`,
    public: `ssh-ed25519 ${publicBlob.toString('base64')}`,
  };
}

/**
 * ssh2's own Ed25519 generator intermittently emits a private key it cannot
 * parse (about 1/256 in this environment). Generate with Node crypto instead
 * and encode the OpenSSH wire format, so ingress tests do not inherit that
 * generator's random failure mode.
 */
export function generateEd25519KeyPair() {
  const { seed, publicKey } = rawEd25519Key();
  return openSshPrivateKey(seed, publicKey);
}
