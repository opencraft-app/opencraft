/**
 * After a deployment, an already-open page may request code-split files that
 * no longer exist. Confirm a newer build is live, then offer one refresh.
 * Plain DOM so the prompt still works when the React tree failed to load.
 */
const MODULE_LOAD_FAILURE =
  /Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Unable to preload CSS|Failed to load module script/i;
let checking = false;
let shown = false;

function runningBuildId(): string | null {
  return document.querySelector<HTMLMetaElement>('meta[name="opencraft-build-id"]')?.content ?? null;
}

export function isModuleLoadFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return MODULE_LOAD_FAILURE.test(message);
}

async function liveBuildId(): Promise<string | null> {
  // Built chunks live under <root>/assets/, next to <root>/version.json.
  const response = await fetch(new URL("../version.json", import.meta.url), {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) return null;
  const value = (await response.json()) as { buildId?: unknown };
  return typeof value.buildId === "string" ? value.buildId : null;
}

function zh() {
  return (document.documentElement.lang || navigator.language || "").toLowerCase().startsWith("zh");
}

function showRefreshPrompt() {
  if (shown) return;
  shown = true;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "opencraft-stale-assets";
  button.setAttribute("role", "status");
  button.textContent = zh() ? "有新版本，点击刷新" : "A new version is available. Tap to refresh";
  button.style.cssText = [
    "position:fixed",
    "z-index:2147483000",
    "left:50%",
    "transform:translateX(-50%)",
    "top:calc(env(safe-area-inset-top, 0px) + 12px)",
    "padding:10px 18px",
    "border:0",
    "border-radius:999px",
    "background:var(--color-background-inverse, #1d1d1f)",
    "color:var(--color-text-inverse, #fff)",
    "font:500 14px/20px -apple-system, system-ui, sans-serif",
    "box-shadow:0 6px 24px rgba(0,0,0,.18)",
    "cursor:pointer",
  ].join(";");
  button.addEventListener("click", () => location.reload());
  document.body.appendChild(button);
}

/** Called for any failure; only module-load failures with a newer live build prompt. */
export function noteRuntimeFailure(error: unknown) {
  if (shown || checking || typeof document === "undefined" || !isModuleLoadFailure(error)) return;
  const current = runningBuildId();
  if (!current) return;
  checking = true;
  void liveBuildId()
    .then((live) => {
      if (live && live !== current) showRefreshPrompt();
    })
    .catch(() => undefined)
    .finally(() => {
      checking = false;
    });
}

export function installStaleAssetDetection() {
  if (typeof window === "undefined") return;
  window.addEventListener("vite:preloadError", (event) =>
    noteRuntimeFailure((event as Event & { payload?: unknown }).payload ?? new Error("Unable to preload CSS")),
  );
  window.addEventListener("opencraft:module-load-failed", (event) => noteRuntimeFailure((event as CustomEvent).detail));
  window.addEventListener("unhandledrejection", (event) => noteRuntimeFailure(event.reason));
}
