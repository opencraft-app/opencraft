import type { ChatRenderContext, ChatResourceDecision, ChatResourceKind, ChatResourceTargetSyntax } from "./contracts";
import type { ChatResourcePolicyService } from "./services/resource-policy-service";

const unsafeScheme = /^(?:javascript|vbscript|data):/iu;
const externalScheme = /^https?:/iu;
const mailScheme = /^mailto:/iu;
const contactScheme = /^(?:sms|tel):/iu;
const fileScheme = /^file:/iu;
const appScheme = /^(?:app|agent|navigation):/iu;
const conversationScheme = /^opencraft:\/\/conversation\/v1\//u;
// Legacy URI input compatibility; hosts still decide whether to open the target.
const legacyCodexAppScheme = /^codex:/iu;
const resourceScheme = /^(?:sandbox|attachment|resource|plugin|mcp):/iu;
const uriScheme = /^[a-z][a-z0-9+.-]*:/iu;
const windowsDrivePath = /^[a-z]:(?!\/\/)/iu;
const windowsAbsolutePath = /^[a-z]:[\\/]/iu;
const posixAbsolutePath = /^\//u;

function decision(kind: ChatResourceKind, target: string): ChatResourceDecision {
  return { allowed: true, kind, target };
}

/** Encode literal Host paths; Markdown URL destinations resolve separately. */
function workspacePathUrl(path: string): string {
  const windowsPath = windowsAbsolutePath.test(path);
  const encodedPath = path.split("/").map((segment, index) =>
    windowsPath && index === 0 ? segment : encodeURIComponent(segment),
  ).join("/");
  // Keep the drive as file-URL structure so parent resolution stops at its root.
  return `file://${windowsPath ? "/" : ""}${encodedPath}`;
}

function workspaceBase(path: string): string {
  const normalized = path.replace(/\\/gu, "/");
  let end = normalized.length;
  while (normalized[end - 1] === "/") end--;
  return normalized.slice(0, end);
}

function workspaceTarget(target: string, cwd: string | null | undefined): string {
  if (fileScheme.test(target)) return target;
  if (windowsDrivePath.test(target) && !windowsAbsolutePath.test(target)) return target;
  if (windowsAbsolutePath.test(target)) return workspacePathUrl(target.replace(/\\/gu, "/"));
  if (posixAbsolutePath.test(target)) return workspacePathUrl(target);
  if (cwd == null || cwd.trim().length === 0) return target;
  const base = workspaceBase(cwd);
  return workspacePathUrl(`${base}/${target.replace(/^\.\//u, "")}`);
}

function workspaceUrlTarget(target: string, cwd: string | null | undefined): string | null {
  if (windowsDrivePath.test(target) && !windowsAbsolutePath.test(target)) return target;
  const absoluteWindowsPath = windowsAbsolutePath.test(target);
  if (!fileScheme.test(target) && !absoluteWindowsPath && !posixAbsolutePath.test(target) && !cwd?.trim()) return target;
  const base = workspaceBase(cwd ?? "");
  try {
    const normalizedTarget = target.replace(/\\/gu, "/");
    const windowsTarget = absoluteWindowsPath ? normalizedTarget
      : /^\/[a-z]:\//iu.test(normalizedTarget) ? normalizedTarget.slice(1) : null;
    const drive = windowsTarget?.slice(0, 2)
      ?? (windowsAbsolutePath.test(`${base}/`) ? base.slice(0, 2) : null);
    // Resolve inside the drive, then restore it: browser URL implementations can
    // otherwise remove a file-URL drive segment when resolving above its root.
    const url = windowsTarget !== null
      ? new URL(windowsTarget.slice(2), "file:///")
      : new URL(target, workspacePathUrl(`${drive === null ? base : base.slice(2)}/`));
    // URL syntax must never turn an unknown scheme into a Host filename.
    if (url.protocol !== "file:") return null;
    decodeURIComponent(url.pathname); // Reject malformed escapes without a literal-path fallback.
    if (fileScheme.test(target)) return url.href;
    return drive === null ? url.href : `file:///${drive}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function stripModelResponseTracking(target: string): string {
  if (!target.includes("oai_link_source=model_response_hotline")) return target;
  try {
    const url = new URL(target);
    const exact = url.search.slice(1).split("&");
    if (!exact.includes("oai_link_source=model_response_hotline")) return target;
    url.search = exact.filter((entry) => entry !== "oai_link_source=model_response_hotline").join("&");
    return url.toString();
  } catch {
    return target;
  }
}

function fileLocationTarget(target: string): { readonly path: string; readonly fragment: string } {
  const colon = /^(.*?):(\d+)(?::(\d+))?(?:[-–](\d+)(?::(\d+))?)?$/u.exec(target);
  if (colon !== null) {
    const [, path, line, column, endLine, endColumn] = colon;
    const fragment = "#L" + line
      + (column === undefined ? "" : "C" + column)
      + (endLine === undefined ? "" : "-L" + endLine + (endColumn === undefined ? "" : "C" + endColumn));
    return { path: path!, fragment };
  }
  const hash = /^(.*?)#L(\d+)(?:C(\d+))?(?:-L(\d+)(?:C(\d+))?)?$/u.exec(target);
  if (hash !== null) return { path: hash[1]!, fragment: target.slice(hash[1]!.length) };
  return { path: target, fragment: "" };
}

/** Renderer-neutral URL classification; host-specific navigation stays in openResource. */
export function resolveStandardChatResource(
  rawTarget: string,
  context: Pick<ChatRenderContext, "cwd" | "externalResourcePolicy">,
  syntax: ChatResourceTargetSyntax = "path",
): ChatResourceDecision {
  const target = rawTarget.replaceAll(String.fromCharCode(96), "").trim();
  if (target.length === 0) return { allowed: false, kind: "blocked", target: null, reason: "Empty resource target" };
  if (unsafeScheme.test(target)) return { allowed: false, kind: "blocked", target: null, reason: "Unsafe resource scheme" };
  if (target.startsWith("#")) return decision("anchor", target);
  if (externalScheme.test(target)) {
    if (context.externalResourcePolicy === "restricted") {
      return { allowed: false, kind: "blocked", target: null, reason: "External resources are restricted" };
    }
    return decision("external", stripModelResponseTracking(target));
  }
  if (target.startsWith("//")) {
    if (context.externalResourcePolicy === "restricted") {
      return { allowed: false, kind: "blocked", target: null, reason: "External resources are restricted" };
    }
    return decision("external", target);
  }
  if (mailScheme.test(target)) return decision("mail", target);
  if (contactScheme.test(target)) return decision("external", target);
  if (appScheme.test(target) || legacyCodexAppScheme.test(target) || conversationScheme.test(target)) return decision("app-route", target);
  if (resourceScheme.test(target)) return decision("resource", target);
  // A valid URI cannot become a workspace-relative file. Drive-relative
  // Windows paths (C:src/main.ts) remain file inputs, like absolute drives.
  const location = syntax === "url" && target.includes("#")
    ? { path: target, fragment: "" }
    : fileLocationTarget(target);
  const fileWithLocation = location.fragment !== "" && /^[^:/\\]+\.[a-z0-9]+$/iu.test(location.path);
  const scheme = fileWithLocation ? undefined : uriScheme.exec(target)?.[0].toLowerCase();
  if (scheme && !fileScheme.test(target) && !windowsDrivePath.test(target)) {
    return { allowed: false, kind: "blocked", target: null, reason: "Unregistered external protocol" };
  }
  const resolved = syntax === "url"
    ? workspaceUrlTarget(location.path, context.cwd)
    : workspaceTarget(location.path, context.cwd);
  if (resolved === null) return { allowed: false, kind: "blocked", target: null, reason: "Invalid workspace URL" };
  const kind = fileScheme.test(location.path) || windowsAbsolutePath.test(location.path) || posixAbsolutePath.test(location.path)
    ? "file" : "workspace-file";
  return decision(kind, resolved + location.fragment);
}

/** Web and Native install the same last-resort policy, leaving higher-priority Host rules in control. */
export function registerStandardChatResourcePolicy(resources: ChatResourcePolicyService, name: string): () => void {
  return resources.register({
    name,
    priority: 0,
    matches: () => true,
    resolve: resolveStandardChatResource,
  });
}
