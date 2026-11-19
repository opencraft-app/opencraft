import QRCode from 'qrcode';

/** Product-owned badge is baked into the PNG, including when the image is saved. */
export async function createMobileGuideQr(value: string): Promise<string> {
  const canvas = document.createElement('canvas');
  await QRCode.toCanvas(canvas, value, {
    scale: 8, margin: 4, errorCorrectionLevel: 'H',
    color: { dark: '#000000', light: '#ffffff' },
  });
  const context = canvas.getContext('2d');
  if (!context) throw new Error('QR canvas is unavailable');
  // Keep the quiet zone intact and mask only a small central area. H correction
  // and decoder checks cover workspace URLs with host and draft routing fields.
  const size = Math.floor(canvas.width * 0.15);
  const start = Math.floor((canvas.width - size) / 2);
  const padding = Math.max(4, Math.floor(size * 0.1));
  const badge = new Image();
  badge.src = new URL('../assets/wechat.svg', import.meta.url).href;
  try {
    await badge.decode();
    context.fillStyle = '#ffffff';
    context.fillRect(start - padding, start - padding, size + padding * 2, size + padding * 2);
    context.fillStyle = '#07c160';
    context.beginPath();
    context.roundRect(start, start, size, size, size * 0.2);
    context.fill();
    const inset = size * 0.13;
    context.drawImage(badge, start + inset, start + inset, size - inset * 2, size - inset * 2);
  } catch {
    // A missing decorative asset must not prevent opening a working QR code.
  }
  return canvas.toDataURL('image/png');
}
