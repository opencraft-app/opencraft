import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'

const DATA_IMAGE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/

function encodedImage(item) {
  if (item?.type !== 'image' || typeof item.url !== 'string') return null
  const match = DATA_IMAGE.exec(item.url)
  if (!match) {
    throw new Error('DSH image input must be an inline PNG, JPEG, WebP, or GIF data URL')
  }
  return { mediaType: match[1], data: match[2] }
}

/**
 * Normalize one provider's declared input capabilities. Missing or malformed
 * metadata is text-only: advertising image support when it is unknown causes
 * the durable DSH history to be serialized with image blocks to providers
 * that cannot accept them.
 */
export function normalizeDshInputModalities(value) {
  if (!Array.isArray(value) || value.length === 0) return ['text']
  return [...new Set(value.map(String))]
}

/**
 * Convert one Codex AppServer Turn input into provider-neutral DSH content.
 * Images are admitted as durable attachments before the user message is
 * published, so history/restart never depends on a Desktop-local path or URL.
 */
export async function dshContentFromAppInput(input, attachments, options = {}) {
  const source = Array.isArray(input) ? input : []
  const inputModalities = options.inputModalities === undefined
    ? ['text', 'image']
    : normalizeDshInputModalities(options.inputModalities)
  if (!inputModalities.includes('image') && source.some(item => (
    item?.type === 'image' || item?.type === 'localImage'
  ))) {
    throw new Error('the selected model accepts text input only; remove the image or select a vision-capable model')
  }
  const images = source.map(encodedImage).filter(Boolean)
  const refs = images.length > 0 ? await admitEncodedImages(attachments, images) : []
  let imageIndex = 0
  const content = []
  for (const item of source) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      content.push({ type: 'text', text: item.text })
    } else if (item?.type === 'image') {
      const ref = refs[imageIndex++]
      if (ref) content.push({ type: 'image', attachment: ref })
    } else if (item?.type === 'localImage') {
      throw new Error(
        `DSH cannot read Desktop-local image path ${JSON.stringify(item.path)}; ` +
        'the AppServer client must send the image as an inline image input',
      )
    }
  }
  return content
}
