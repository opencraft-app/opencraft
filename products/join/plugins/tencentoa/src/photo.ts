/** The browser uses its own OA network/session; server-side directory proxy is optional. */
export function employeePhotoUrl(name: string): string | null {
  return /^[A-Za-z0-9._-]{1,128}$/u.test(name)
    ? `https://rhrc.woa.com/photo/150/${encodeURIComponent(name)}.png` : null;
}
