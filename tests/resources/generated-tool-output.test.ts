import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { ArtifactCatalog } from '../../apps/local-agent-host/src/artifacts/catalog.js';
import { captureGeneratedOutputs } from '../../apps/local-agent-host/src/artifacts/tool-output.js';
import { LocalAttachmentStagingService } from '../../apps/local-agent-host/src/attachments/local-attachment-staging.js';
const outside = (e: unknown) => e instanceof AggregateError && e.errors.some(x => /outside authorized roots/.test(String(x)));
const mime = (e: unknown) => e instanceof AggregateError && e.errors.some(x => /MIME/.test(String(x)));
const encoded = (value: string) => Buffer.from(value).toString('base64');
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'generated-tool-output-'));
  const catalog = new ArtifactCatalog(root);
  t.after(async () => { catalog.close(); await rm(root, { recursive: true, force: true }); });
  return { root, catalog };
}
const event = (content: unknown[], structuredContent?: unknown) => ({ type: 'mcpToolCall', id: 'call-1', status: 'completed', result: { content, structuredContent } });

test('MCP audio, video, PDF and text resources persist in distinct immutable slots and replay safely', async t => {
  const { root, catalog } = await setup(t);
  const item = event([
    { type: 'audio', mimeType: 'audio/wav', data: encoded('audio') },
    { type: 'resource', resource: { uri: 'generated:movie', mimeType: 'video/mp4', blob: encoded('video') } },
    { type: 'resource', resource: { uri: 'generated:report', mimeType: 'application/pdf', blob: encoded('pdf') } },
    { type: 'resource', resource: { uri: 'generated:notes', mimeType: 'text/markdown', text: '# 文档' } },
  ]);
  const saved = await captureGeneratedOutputs(catalog, 'producer', 'thread', item);
  assert.equal(new Set(saved.map(a => a.id)).size, 4);
  assert.deepEqual(await Promise.all(saved.map(a => readFile(a.path, 'utf8'))), ['audio', 'video', 'pdf', '# 文档']);
  assert.deepEqual(await captureGeneratedOutputs(catalog, 'producer', 'thread', item), saved);
  assert.equal(catalog.gcCandidates(Date.now() + 1).length, 0);
  const staging = new LocalAttachmentStagingService(join(root, 'attachments'), root);
  try {
    for (const artifact of saved) {
      const ref = await staging.referenceForHostPath(artifact.name, artifact.path);
      assert.ok(ref);
      assert.equal((await staging.artifact(ref, 'other-thread')).id, artifact.id);
    }
  } finally { await staging.close(); }
  const changed = structuredClone(item); (changed.result.content[0] as any).data = encoded('changed');
  await assert.rejects(captureGeneratedOutputs(catalog, 'producer', 'thread', changed), AggregateError);
  assert.equal(await readFile(saved[0]!.path, 'utf8'), 'audio');
});

test('explicit large-file outputs use the execution reader, survive source deletion, and dispose the reader', async t => {
  const { root, catalog } = await setup(t);
  const source = join(root, 'report.docx'); await writeFile(source, 'office content');
  let disposed = 0;
  const item = event([], { artifacts: [{ id: 'report', name: 'report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', savedPath: '/execution/report.docx' }] });
  const saved = await captureGeneratedOutputs(catalog, 'producer', 'thread', item, async path => {
    assert.equal(path, '/execution/report.docx');
    return { body: Readable.from([await readFile(source)]), dispose: async () => { disposed++; } };
  }, undefined, { savedPathRoots: ['/execution'] });
  await rm(source);
  assert.equal(disposed, 1); assert.equal(await readFile(saved[0]!.path, 'utf8'), 'office content');
});

test('code-mode and dynamic audio data outputs are captured without interpreting ordinary tool text', async t => {
  const { catalog } = await setup(t);
  for (const item of [
    { type: 'functionCallOutput', id: 'code', output: [{ type: 'input_audio', audio_url: `data:audio/mpeg;base64,${encoded('mp3')}` }] },
    { type: 'dynamicToolCall', id: 'dynamic', status: 'completed', success: true, contentItems: [{ type: 'inputAudio', audioUrl: `data:audio/mpeg;base64,${encoded('mp3')}` }] },
  ]) assert.equal((await captureGeneratedOutputs(catalog, 'producer', 'thread', item))[0]!.mimeType, 'audio/mpeg');
  const external = event([{ type: 'resource_link', uri: 'https://example.invalid/video.mp4' }, { type: 'text', text: '/private/credentials.pdf' }]);
  assert.deepEqual(await captureGeneratedOutputs(catalog, 'producer', 'thread', external, async () => { throw Error('must not read'); }), []);
  for (const item of [{ ...external, status: 'inProgress' }, { ...external, error: {} }, { ...external, success: false }])
    assert.deepEqual(await captureGeneratedOutputs(catalog, 'producer', 'thread', item), []);
});

test('a malformed sibling does not prevent valid output persistence; retry repairs only the failed slot', async t => {
  const { catalog } = await setup(t);
  const item = event([{ type: 'audio', mimeType: 'audio/wav', data: 'broken' }, { type: 'resource', resource: { mimeType: 'application/pdf', blob: encoded('pdf') } }]);
  await assert.rejects(captureGeneratedOutputs(catalog, 'producer', 'thread', item), AggregateError);
  const pdfId = catalog.id({ scope: 'producer', key: JSON.stringify(['generation', 'thread', 'call-1', 'content:1']) });
  const pdf = catalog.get(pdfId); assert.ok(pdf);
  (item.result.content[0] as any).data = encoded('audio');
  const saved = await captureGeneratedOutputs(catalog, 'producer', 'thread', item);
  assert.equal(saved[1]!.path, pdf.path);
});

test('all uploaded MIME types, including unknown ones, are catalogued before successful one-shot and chunk acknowledgement', async t => {
  const { root } = await setup(t);
  const staging = new LocalAttachmentStagingService(join(root, 'uploads'), root);
  try {
    for (const [index, mimeType] of ['audio/mpeg', 'video/mp4', 'application/pdf', 'application/octet-stream', ''].entries()) {
      const request = { clientAttachmentId: `file-${index}`, name: `file-${index}`, mimeType, size: 3 };
      const one = await staging.stage({ ...request, source: { kind: 'client-bytes', dataBase64: encoded('abc') } });
      assert.deepEqual(await staging.stage({ ...request, source: { kind: 'client-bytes', dataBase64: encoded('abc') } }), one);
      const chunk = await staging.handle('attachment/uploadChunk', { ...request, clientAttachmentId: `chunk-${index}`, uploadId: `upload-identity-${index}`, offset: 0, dataBase64: encoded('abc') }) as any;
      for (const ref of [one.ref, chunk.ref]) {
        const artifact = staging.catalog.findPath(ref.location.path); assert.ok(artifact);
        assert.equal(artifact.mimeType, mimeType || 'application/octet-stream');
        assert.equal(staging.catalog.hasReferences(artifact.id), true);
      }
    }
  } finally { await staging.close(); }
});

test('tool-declared paths are read only inside explicitly authorized roots', async t => {
  const { root, catalog } = await setup(t);
  const allowed = join(root, 'outputs'), secret = join(root, 'secret.txt');
  await mkdir(allowed); await writeFile(join(allowed, 'ok.txt'), 'ok'); await writeFile(secret, 'secret');
  await symlink(secret, join(allowed, 'link.txt'));
  const item = (id: string, savedPath: string) => event([], { artifacts: [{ id, mimeType: 'text/plain', savedPath }] });
  await assert.rejects(captureGeneratedOutputs(catalog, 'p', 'thread', item('a', join(allowed, 'ok.txt'))), outside, 'no roots means no path reads');
  await assert.rejects(captureGeneratedOutputs(catalog, 'p', 'thread', item('b', secret), undefined, undefined, { savedPathRoots: [allowed] }), outside);
  await assert.rejects(captureGeneratedOutputs(catalog, 'p', 'thread', item('c', join(allowed, 'link.txt')), undefined, undefined, { savedPathRoots: [allowed] }), outside, 'symbolic links cannot escape');
  await assert.rejects(captureGeneratedOutputs(catalog, 'p', 'thread', item('d', join(allowed, '..', 'secret.txt')), undefined, undefined, { savedPathRoots: [allowed] }), outside);
  const remote = async () => ({ body: Readable.from([Buffer.from('remote')]), dispose: async () => {} });
  await assert.rejects(captureGeneratedOutputs(catalog, 'p', 'thread', item('e', '/execution/../etc/passwd'), remote, undefined, { savedPathRoots: ['/execution'] }), outside);
  const [saved] = await captureGeneratedOutputs(catalog, 'p', 'thread', item('f', join(allowed, 'ok.txt')), undefined, undefined, { savedPathRoots: [allowed] });
  assert.equal(await readFile(saved!.path, 'utf8'), 'ok');
});

test('a malformed structured identity is isolated from valid siblings', async t => {
  const { catalog } = await setup(t);
  const item = event([{ type: 'audio', mimeType: 'audio/wav', data: encoded('first') }], { artifacts: [
    { id: 'good', mimeType: 'text/plain', dataBase64: encoded('good') }, { id: '', mimeType: 'text/plain', dataBase64: encoded('x') },
    { id: 'good', mimeType: 'text/plain', dataBase64: encoded('duplicate') }] });
  const error = await captureGeneratedOutputs(catalog, 'p', 'thread', item).then(() => null, e => e);
  assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
  for (const slot of ['content:0', 'artifact:good'])
    assert.ok(catalog.get(catalog.id({ scope: 'p', key: JSON.stringify(['generation', 'thread', 'call-1', slot]) })), slot);
});

test('MIME parameters such as audio codecs are accepted and kept', async t => {
  const { catalog } = await setup(t);
  const [saved] = await captureGeneratedOutputs(catalog, 'p', 'thread', event([{ type: 'audio', mimeType: 'audio/webm;codecs=opus', data: encoded('voice') }]));
  assert.equal(saved!.mimeType, 'audio/webm;codecs=opus'); assert.equal(saved!.name, 'generated.weba');
  await assert.rejects(captureGeneratedOutputs(catalog, 'p', 'thread2', event([{ type: 'audio', mimeType: 'audio/webm;\r\nx=y', data: encoded('v') }])), mime);
});

test('replaying a path output reuses the committed copy after its source is deleted', async t => {
  const { root, catalog } = await setup(t);
  const dir = join(root, 'out'); await mkdir(dir); await writeFile(join(dir, 'clip.mp4'), 'clip');
  const item = event([], { artifacts: [{ id: 'clip', mimeType: 'video/mp4', savedPath: join(dir, 'clip.mp4') }] });
  const [first] = await captureGeneratedOutputs(catalog, 'p', 'thread', item, undefined, undefined, { savedPathRoots: [dir] });
  await rm(join(dir, 'clip.mp4'));
  const [again] = await captureGeneratedOutputs(catalog, 'p', 'thread', item, undefined, undefined, { savedPathRoots: [dir] });
  assert.equal(again!.id, first!.id); assert.equal(await readFile(again!.path, 'utf8'), 'clip');
});

test('host capture catalogues completed items from every subscribed engine once, then stops', async t => {
  const { root, catalog } = await setup(t);
  const { HostArtifactCapture, generatedFileRootsFromEnvironment } = await import('../../apps/local-agent-host/src/artifacts/host-capture.js');
  const listeners: Array<(method: string, params: unknown) => void> = [];
  const subscribe = (listener: (method: string, params: unknown) => void) => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); };
  const failures: unknown[] = [];
  const capture = new HostArtifactCapture(() => catalog, { roots: () => [root], diagnostic: entry => failures.push(entry) }).observe(subscribe).observe(subscribe);
  const emit = (method: string, params: unknown) => { for (const listener of [...listeners]) listener(method, params); };
  emit('item/completed', { threadId: 'acp-thread', item: { type: 'dynamicToolCall', id: 'shot', success: true,
    contentItems: [{ type: 'inputImage', imageUrl: `data:image/png;base64,${encoded('png')}` }] } });
  emit('item/started', { threadId: 'acp-thread', item: { type: 'dynamicToolCall', id: 'ignored', contentItems: [{ imageUrl: `data:image/png;base64,${encoded('x')}` }] } });
  emit('item/completed', { threadId: 'dsh-thread', item: { type: 'agentMessage', id: 'text', text: 'hello' } });
  emit('item/completed', { threadId: 'dsh-thread', item: { type: 'mcpToolCall', id: 'bad', status: 'completed', result: { content: [{ type: 'audio', mimeType: 'bad mime', data: encoded('a') }] } } });
  await capture.settled();
  const artifact = catalog.get(catalog.id({ scope: 'host-generated', key: JSON.stringify(['generation', 'acp-thread', 'shot', 'content:0']) }));
  assert.ok(artifact); assert.equal(await readFile(artifact.path, 'utf8'), 'png');
  assert.equal(catalog.get(catalog.id({ scope: 'host-generated', key: JSON.stringify(['generation', 'acp-thread', 'ignored', 'content:0']) })), null);
  assert.equal(failures.length, 2, 'one diagnostic per subscription for the malformed item');
  await capture.close();
  assert.equal(listeners.length, 0);
  assert.deepEqual(generatedFileRootsFromEnvironment({ OPENCRAFT_GENERATED_FILE_ROOTS: ['/a', 'relative', ' /b '].join((await import('node:path')).delimiter) }), ['/a', '/b']);
});
