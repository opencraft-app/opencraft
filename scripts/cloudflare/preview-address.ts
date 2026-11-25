import { readFile } from "node:fs/promises";
import type { CloudflareApi } from "./cloudflare-runtime.ts";

const name = "opencraft-preview";
const path = "/workers/scripts/" + name;
type PreviewApi = Pick<CloudflareApi, "call">;
type Binding = { name: string; type: string; text?: string; service?: string };

export const previewPublicOrigin = (subdomain: string) => `https://${name}.${subdomain}.workers.dev`;
export function isPreviewCustomOrigin(value: unknown): value is string {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.origin === value &&
    !url.port &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/u.test(url.hostname)
  );
}

export async function inspectPreviewAddress(api: PreviewApi, origin: string) {
  try {
    const { bindings } = await api.call<{ bindings: Binding[] }>("GET", path + "/settings");
    const publicOrigin = bindings.find(
      (entry) => entry.name === "PREVIEW_PUBLIC_ORIGIN" && entry.type === "plain_text",
    )?.text;
    const customOrigin = bindings.find(
      (entry) => entry.name === "PREVIEW_CUSTOM_ORIGIN" && entry.type === "plain_text",
    )?.text;
    const targetOrigin = bindings.find(
      (entry) => entry.name === "PREVIEW_TARGET_ORIGIN" && entry.type === "plain_text",
    )?.text;
    const target = bindings.find((entry) => entry.name === "PREVIEW_TARGET" && entry.type === "service")?.service;
    if (publicOrigin !== origin || !target || !/^opencraft-preview-cf-[a-f0-9]{8}$/u.test(target))
      throw Error("The fixed preview name is already in use");
    return { target, targetOrigin, customOrigin };
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    return null;
  }
}

export async function syncPreviewAddress(
  api: PreviewApi,
  origin: string,
  active: { worker: string; origin: string },
  customOrigin?: string,
) {
  const current = await inspectPreviewAddress(api, origin);
  const matches = (binding: typeof current) =>
    binding?.target === active.worker &&
    binding.targetOrigin === active.origin &&
    binding.customOrigin === customOrigin;
  if (!matches(current)) {
    const form = new FormData();
    form.set(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: "worker.mjs",
            compatibility_date: "2026-11-01",
            bindings: [
              { name: "PREVIEW_PUBLIC_ORIGIN", type: "plain_text", text: origin },
              ...(customOrigin ? [{ name: "PREVIEW_CUSTOM_ORIGIN", type: "plain_text", text: customOrigin }] : []),
              { name: "PREVIEW_TARGET_ORIGIN", type: "plain_text", text: active.origin },
              { name: "PREVIEW_TARGET", type: "service", service: active.worker, environment: "production" },
            ],
          }),
        ],
        { type: "application/json" },
      ),
    );
    const code = await readFile(new URL("./preview-address-worker.mjs", import.meta.url));
    form.set("worker.mjs", new Blob([code], { type: "application/javascript+module" }), "worker.mjs");
    await api.call("PUT", path, form);
  }
  const route = await api.call<{ enabled: boolean }>("GET", path + "/subdomain");
  if (!route.enabled) await api.call("POST", path + "/subdomain", { enabled: true, previews_enabled: false });
  if (
    !matches(await inspectPreviewAddress(api, origin)) ||
    !(await api.call<{ enabled: boolean }>("GET", path + "/subdomain")).enabled
  )
    throw Error("The fixed preview address did not route to the active preview");
}
