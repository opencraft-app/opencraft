const decodeImage = (file: File): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const objectURL = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    URL.revokeObjectURL(objectURL);
    resolve(image);
  };
  image.onerror = () => {
    URL.revokeObjectURL(objectURL);
    reject(new Error("头像图片无法解析。"));
  };
  image.src = objectURL;
});

const canvasToBlob = (canvas: HTMLCanvasElement, quality: number): Promise<Blob> => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => {
    if (!blob) {
      reject(new Error("头像图片压缩失败。"));
      return;
    }
    resolve(blob);
  }, "image/jpeg", quality);
});

export const compressAvatarFile = async (
  file: File,
  options: { maxBytes: number },
): Promise<File> => {
  const { maxBytes } = options;
  if (file.size <= maxBytes) {
    return file;
  }

  const image = await decodeImage(file);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("浏览器当前不支持头像压缩。");
  }

  const scaleSteps = [1, 0.92, 0.84, 0.76, 0.68, 0.6];
  const qualities = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42];

  for (const scale of scaleSteps) {
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    for (const quality of qualities) {
      const blob = await canvasToBlob(canvas, quality);
      if (blob.size <= maxBytes) {
        return new File([blob], file.name.replace(/\.[^.]+$/, "") || "avatar.jpg", {
          type: "image/jpeg",
          lastModified: Date.now(),
        });
      }
    }
  }

  throw new Error("头像压缩后仍超过 200KB，请换一张更小的图片。");
};
