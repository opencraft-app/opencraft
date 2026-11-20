/** Generated screenshot pixels only, not PNG compression metadata. */
export async function compareToolbarPixels(page, before, after) {
  return page.evaluate(async ({ a, b }) => {
    const decode = async value => {
      const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
      const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d"); context.drawImage(image, 0, 0); image.close();
      return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const left = await decode(a), right = await decode(b);
    if (left.width !== right.width || left.height !== right.height) throw new Error("Toolbar screenshot geometry changed");
    let changedPixels = 0, maxChannelDelta = 0;
    for (let i = 0; i < left.data.length; i += 4) {
      let difference = 0;
      for (let c = 0; c < 4; c++) difference = Math.max(difference, Math.abs(left.data[i + c] - right.data[i + c]));
      if (difference) changedPixels++;
      maxChannelDelta = Math.max(maxChannelDelta, difference);
    }
    return { changedPixels, maxChannelDelta, totalPixels: left.width * left.height };
  }, { a: before.toString("base64"), b: after.toString("base64") });
}

/** A measured1pixel/5level compositing-edge rounding is not opaque chrome.
 * Keep a strict absolute bound: never hide broad tint, motion or covered icons. */
export function equivalentToolbarRaster(delta) {
  return delta.totalPixels > 0 && delta.changedPixels <= 2 && delta.maxChannelDelta <= 8;
}
