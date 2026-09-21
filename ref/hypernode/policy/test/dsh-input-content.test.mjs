import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createUserMessage,
  projectImagesForTextModel,
} from '@deepseek-ai/dsh-llm'
import {
  dshContentFromAppInput,
  normalizeDshInputModalities,
} from '../../scripts/dsh-input-content.mjs'

test('DSH provider capability defaults to text and never invents image support', () => {
  assert.deepEqual(normalizeDshInputModalities(undefined), ['text'])
  assert.deepEqual(normalizeDshInputModalities([]), ['text'])
  assert.deepEqual(normalizeDshInputModalities(['text', 'image', 'image']), ['text', 'image'])
})

test('DSH projects durable historical images only at a text-provider boundary', () => {
  const messages = [createUserMessage({
    content: [
      { type: 'text', text: 'remember this image' },
      {
        type: 'image',
        attachment: {
          attachmentId: `sha256:${'a'.repeat(64)}`,
          mediaType: 'image/png',
          bytes: 5,
          width: 1,
          height: 1,
        },
      },
    ],
    source: { kind: 'user' },
  })]

  const projected = projectImagesForTextModel(messages)
  assert.equal(messages[0].content[1].type, 'image', 'the durable ledger must remain lossless')
  assert.deepEqual(projected[0].content, [
    { type: 'text', text: 'remember this image' },
    { type: 'text', text: '[image omitted because this model accepts text only; attachment sha256:aaaaaaaa]' },
  ])
})

test('DSH input conversion preserves text/image order and admits image bytes', async () => {
  const saved = []
  const attachments = {
    async saveImages(inputs) {
      saved.push(...inputs)
      return inputs.map((input, index) => ({
        attachmentId: `sha256:image-${index}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
      }))
    },
  }
  const content = await dshContentFromAppInput([
    { type: 'text', text: 'look' },
    { type: 'image', url: 'data:image/png;base64,aGVsbG8=' },
    { type: 'text', text: 'again' },
  ], attachments)

  assert.deepEqual(content, [
    { type: 'text', text: 'look' },
    {
      type: 'image',
      attachment: {
        attachmentId: 'sha256:image-0', mediaType: 'image/png', bytes: 5, width: 1, height: 1,
      },
    },
    { type: 'text', text: 'again' },
  ])
  assert.equal(Buffer.from(saved[0].data).toString(), 'hello')
})

test('DSH input conversion rejects a Desktop-local path instead of silently dropping it', async () => {
  await assert.rejects(
    dshContentFromAppInput([{ type: 'localImage', path: '/Users/me/Desktop/a.jpg' }], {
      saveImages: async () => [],
    }),
    /Desktop-local image path/,
  )
})

test('DSH rejects a new image before dispatching a text-only provider request', async () => {
  let admitted = false
  await assert.rejects(
    dshContentFromAppInput([
      { type: 'text', text: 'look' },
      { type: 'image', url: 'data:image/png;base64,aGVsbG8=' },
    ], {
      saveImages: async () => {
        admitted = true
        return []
      },
    }, { inputModalities: ['text'] }),
    /accepts text input only/,
  )
  assert.equal(admitted, false)
})
