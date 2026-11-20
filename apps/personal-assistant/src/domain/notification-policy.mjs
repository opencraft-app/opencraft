export function notificationPolicy(value = "never") {
  if (!["always", "never", "changed"].includes(value))
    throw new Error("notify must be always, never or changed");
  return value;
}
export function workOrigin(work) {
  return work.origin_json
    ? JSON.parse(work.origin_json)
    : {
        kind: work.source === "routine" ? "routine" : "direct",
        notify: work.source === "routine" ? "never" : "always",
      };
}
