export function browserHostname(): string | undefined {
  const location = (
    globalThis as typeof globalThis & {
      location?: {hostname?: string};
    }
  ).location;
  return location?.hostname;
}

export function browserSearch(): string {
  const location = (
    globalThis as typeof globalThis & {
      location?: {search?: string};
    }
  ).location;
  return location?.search ?? "";
}
