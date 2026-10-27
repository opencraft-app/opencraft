import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { AssertionProvider, AssertionSigner, ASSERTION_HEADER } from '../../packages/identity-core/src/node';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const scope = { issuer: 'probe-fixture', instanceId: 'team', origin: 'https://team.test' };
const signer = new AssertionSigner(scope, privateKey);
const principal = { provider: 'local', subject: 'person', displayName: 'Person', expiresAt: Date.now() + 60_000 };
function probe(url: string, token: string, method = 'GET', path = '/document?view=one') {
  return { method, url, headers: { host: 'team.test', [ASSERTION_HEADER]: token,
    'x-opencraft-relay-probe-method': 'HEAD', 'x-opencraft-relay-probe-path': path } };
}

test('default admission probe is exact and private compatibility names are not core routes', () => {
  const provider = new AssertionProvider(scope, publicKey);
  const issue = () => signer.issue(principal, 'HEAD', '/document?view=one');
  assert.equal(provider.authenticate(probe('/__opencraft_access/admission', issue()))?.subject, 'person');
  for (const path of ['/legacy/admission', '/not-a-probe', '/__opencraft_access/admission?x=1'])
    assert.equal(provider.authenticate(probe(path, issue())), null, path);
  assert.equal(provider.authenticate(probe('/__opencraft_access/admission', issue(), 'POST')), null);
  assert.equal(provider.authenticate(probe('/__opencraft_access/admission', issue(), 'GET', '/document?view=two')), null);
});

test('trusted additional probes retain method/path binding, expiry and single-use assertions', () => {
  let now = Date.now();
  const paths = ['/legacy/admission'];
  const provider = new AssertionProvider(scope, publicKey, () => now, { additionalAdmissionProbePaths: paths });
  paths.push('/late-added');
  const issue = () => signer.issue(principal, 'HEAD', '/document?view=one', now);
  const token = issue(), request = probe('/legacy/admission', token);
  assert.equal(provider.authenticate(request)?.subject, 'person');
  assert.equal(provider.authenticate(request)?.subject, 'person', 'request-local cache is unchanged');
  assert.equal(provider.authenticate(probe('/legacy/admission', token)), null, 'wire replay');
  for (const path of ['/late-added', '/legacy/admission?x=1', '/elsewhere'])
    assert.equal(provider.authenticate(probe(path, issue())), null, path);
  assert.equal(provider.authenticate(probe('/legacy/admission', issue(), 'POST')), null);
  assert.equal(provider.authenticate(probe('/legacy/admission', issue(), 'GET', '/wrong')), null);
  const expired = issue(); now += 30_001;
  assert.equal(provider.authenticate(probe('/legacy/admission', expired)), null);
});

test('invalid trusted probe configuration is rejected, rather than silently widening admission', () => {
  for (const paths of [null, 'any', ['/'], ['https://evil.test/probe'], ['//evil.test/probe'], ['/path?x=1'], ['/path#x'], ['/a/../probe'], ['/probe\n'], [123], Array(17).fill('/probe')])
    assert.throws(() => new AssertionProvider(scope, publicKey, Date.now, { additionalAdmissionProbePaths: paths as string[] }), /admission probe/i);
});
