/** Credential checks return a boolean; the key never enters a bridge frame. */
export const CURSOR_KEY_GUIDANCE =
  "Cursor SDK API key is missing or could not be used. Create a User API key at https://cursor.com/dashboard/api, "
  + "then set CURSOR_API_KEY in the Engine Host environment. Alternatively, sign in "
  + "with the Cursor SDK and keep its existing credential store. Cursor CLI login alone is not an SDK API key.";

export async function hasCursorCredentials(
  env: Readonly<Record<string, string | undefined>>,
  sdkStatus: () => Promise<{ status: string }>,
): Promise<boolean> {
  if (env.CURSOR_API_KEY?.trim()) return true;
  return (await sdkStatus()).status === "logged-in";
}
