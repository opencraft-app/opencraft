import { createHash, createHmac, createPublicKey, randomBytes, sign, timingSafeEqual, verify } from 'node:crypto';

export const RECEIVER_AUDIENCE = 'opencraft.wecom.receiver.v1';
export const RECEIVER_LEASE_MS = 3600000;
const hash = value => createHash('sha256').update(value).digest('hex');
const mac = (key, value) => createHmac('sha256', key).update(value).digest('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const receiverHubId = publicKey => 'hub-' + hash(createPublicKey(publicKey).export({format:'der',type:'spki'}).toString('base64')).slice(0,40);

/** A different audience prevents a receiver proof from authorizing Hub enrollment. */
export function receiverProof(identity, relay, now = Date.now()) {
  const proof = {audience:RECEIVER_AUDIENCE,relay,serverId:identity.serverId,
    ...(identity.publicKey ? {publicKey:identity.publicKey} : {}),timestamp:now,nonce:randomBytes(32).toString('base64url')};
  const body = JSON.stringify(proof);
  return {...proof,signature:identity.privateKey
    ? sign(null,Buffer.from(body),identity.privateKey).toString('base64url') : mac(identity.credential,body)};
}

/** Credentials are scoped to this receiver and trust generation. Redis owns the
 * expiring lease; all replicas consult the current route/Hub owner on every use. */
export function createReceiverEnrollment({store,routes,hub,relayOrigin,corpId,signingKey,now=Date.now}) {
  if (!signingKey || !corpId || !relayOrigin) throw Error('invalid_receiver_enrollment');
  const prefix = store.prefix + 'receiver:';
  const endpoint = () => hub?.snapshot().endpoint || relayOrigin;
  function identity(id, publicKey) {
    const route = routes.find(route => route.instanceId === id);
    if (route) {
      if (publicKey) throw Error('denied');
      return {name:route.name || id,fingerprint:hash(route.credential),credential:route.credential};
    }
    if (!publicKey || receiverHubId(publicKey) !== id) throw Error('denied');
    const peer = hub?.snapshot().peers.find(peer => peer.hubId === id && peer.connected);
    const available = hub?.routes().some(route => route.service.hubId === id);
    if (!peer || !available) throw Error('denied');
    return {name:peer.name || id,fingerprint:hash(publicKey)};
  }
  return {
    async enroll(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['audience','relay','serverId','publicKey','timestamp','nonce','signature'].includes(key))
        || input.audience !== RECEIVER_AUDIENCE || input.relay !== endpoint()
        || typeof input.serverId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(input.serverId)
        || !Number.isSafeInteger(input.timestamp) || Math.abs(now()-input.timestamp)>300000
        || typeof input.nonce !== 'string' || !/^[-_A-Za-z0-9]{43}$/u.test(input.nonce)
        || typeof input.signature !== 'string' || !/^[-_A-Za-z0-9]{43,86}$/u.test(input.signature)
        || (input.publicKey !== undefined && (typeof input.publicKey !== 'string' || input.publicKey.length>4096))) throw Error('denied');
      const {signature,...proof} = input;
      // Reconstruct the signed representation: incoming JSON property order is not authority.
      const canonical = {audience:proof.audience,relay:proof.relay,serverId:proof.serverId,
        ...(proof.publicKey ? {publicKey:proof.publicKey} : {}),timestamp:proof.timestamp,nonce:proof.nonce};
      const owner = identity(input.serverId,input.publicKey),body=JSON.stringify(canonical);
      if (input.publicKey ? !verify(null,Buffer.from(body),input.publicKey,Buffer.from(signature,'base64url'))
        : !equal(signature,mac(owner.credential,body))) throw Error('denied');
      const claimed = await store.command('SET',prefix+'nonce:'+hash(input.serverId+':'+input.nonce),'1','PX',600000,'NX');
      if (claimed !== 'OK') throw Error('denied');
      const expiresAt = now()+RECEIVER_LEASE_MS;
      // Stable across renewal/restart: native file identities must not change on renewal.
      const credential = mac(signingKey,JSON.stringify([RECEIVER_AUDIENCE,corpId,input.serverId,owner.fingerprint]));
      await store.command('SET',prefix+'lease:'+input.serverId,JSON.stringify({fingerprint:owner.fingerprint,
        digest:hash(credential),expiresAt,...(input.publicKey?{publicKey:input.publicKey}:{})}),'PX',RECEIVER_LEASE_MS);
      return {relayOrigin:endpoint(),serverId:input.serverId,corpId,credential,expiresAt};
    },
    async authenticate(id, credential) {
      const raw = await store.command('GET',prefix+'lease:'+id);
      if (!raw) throw Error('denied');
      const lease = JSON.parse(raw),owner=identity(id,lease.publicKey);
      if (lease.expiresAt<=now() || lease.fingerprint!==owner.fingerprint || !equal(hash(credential),lease.digest)) throw Error('denied');
      return {id,name:owner.name,digest:Buffer.from(lease.digest,'hex'),legacyRecording:false};
    },
  };
}
