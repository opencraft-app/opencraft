export interface NativeGalleryImage {
  readonly key: string;
  readonly source: string;
  readonly alt: string;
  readonly order: number;
}

export function orderedNativeGalleryImages(images: readonly NativeGalleryImage[]): readonly NativeGalleryImage[] {
  return [...images].sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
}

export function neighboringNativeGalleryImage(
  images: readonly NativeGalleryImage[],
  currentKey: string,
  direction: -1 | 1,
): NativeGalleryImage | null {
  const index = images.findIndex(image => image.key === currentKey);
  return index < 0 ? null : images[index + direction] ?? null;
}
