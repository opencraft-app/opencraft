import type { ChatRenderContext, ChatResourceDecision, ChatResourceKind } from "./contracts";
import type { ChatResourcePolicyService } from "./services/resource-policy-service";

const unsafeScheme = /^(?:javascript|vbscript|data):/iu;
const externalScheme = /^https?:/iu;
const mailScheme = /^mailto:/iu;
const contactScheme = /^(?:sms|tel):/iu;
const fileScheme = /^file:/iu;
const appScheme = /^(?:codex|app|agent|navigation):/iu;
const resourceScheme = /^(?:sandbox|attachment|resource|plugin|mcp):/iu;
const windowsAbsolutePath = /^[a-z]:[\\/]/iu;
const posixAbsolutePath = /^\//u;

function decision(kind: ChatResourceKind, target: string): ChatResourceDecision {
  return { allowed: true, kind, target };
}

function workspaceTarget(target: string, cwd: string | null | undefined): string {
  if (fileScheme.test(target)) return target;
  if (windowsAbsolutePath.test(target)) return `file:///${target.replace(/\\/gu, "/")}`;
  if (posixAbsolutePath.test(target)) return `file://${target}`;
  if (cwd == null || cwd.trim().length === 0) return target;
  const base = cwd.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return `file://${base}/${target.replace(/^\.\//u, "")}`;
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
  if (appScheme.test(target)) return decision("app-route", target);
  if (resourceScheme.test(target)) return decision("resource", target);
  const location = fileLocationTarget(target);
  if (fileScheme.test(location.path) || windowsAbsolutePath.test(location.path) || posixAbsolutePath.test(location.path)) {
    return decision("file", workspaceTarget(location.path, context.cwd) + location.fragment);
  }
  return decision("workspace-file", workspaceTarget(location.path, context.cwd) + location.fragment);
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
