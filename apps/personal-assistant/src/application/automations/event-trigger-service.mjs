import { digest, requireText, stable } from "../../domain/values.mjs";
import { notificationPolicy } from "../../domain/notification-policy.mjs";

const eventType = (type) => {
  if (typeof type !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(type))
    throw new Error("Invalid event type");
  return type;
};
function relativePath(path) {
  requireText(path, "event path", 500);
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Event path must be relative");
  return path;
}
/** Owns rule definitions, source observations and durable event admission/matching. */
export class EventTriggerService {
  constructor({
    repository,
    inbox,
    uow,
    workPort,
    history,
    captureResources,
    canObserve,
    now = Date.now,
  }) {
    Object.assign(this, {
      repository,
      inbox,
      uow,
      workPort,
      history,
      captureResources,
      canObserve,
      now,
    });
  }
  add(inputId, params) {
    const type = eventType(params.eventType),
      goal = requireText(params.goal, "event goal");
    const path = params.path === undefined ? null : relativePath(params.path);
    if (type === "file.changed" && !path)
      throw new Error("File rules require a relative path");
    const notify = notificationPolicy(params.notify);
    return this.inbox.accept(inputId, "trigger.add", params, () => {
      if (this.repository.rules().length >= 32)
        throw new Error("At most 32 event rules");
      const resources = this.captureResources(inputId);
      if (type === "file.changed" && !this.canObserve(resources))
        throw new Error("File events require a configured material source");
      const id = `trigger_${digest(inputId).slice(0, 24)}`;
      this.repository.addRule({
        id,
        type,
        path,
        goal,
        notify,
        resources,
      });
      return { triggerId: id, revision: 1 };
    });
  }
  enable(inputId, params) {
    return this.inbox.accept(inputId, "trigger.enable", params, () => {
      const rule = this.repository.rule(params.triggerId);
      if (!rule || params.expectedRevision !== rule.revision)
        throw new Error("Unknown or stale trigger revision");
      if (typeof params.enabled !== "boolean")
        throw new Error("enabled must be boolean");
      this.repository.enable(rule.id, params.enabled);
      return {
        triggerId: rule.id,
        enabled: params.enabled,
        revision: rule.revision + 1,
      };
    });
  }
  list() {
    return this.repository.rules();
  }
  watchedPaths() {
    return [
      ...new Set(
        this.list()
          .filter(
            (r) =>
              r.enabled &&
              r.type === "file.changed" &&
              this.canObserve(r.resources),
          )
          .map((r) => r.path),
      ),
    ];
  }
  emit(inputId, params) {
    const type = eventType(params.eventType);
    const data = params.data ?? {};
    if (
      !data ||
      Array.isArray(data) ||
      typeof data !== "object" ||
      new TextEncoder().encode(stable(data)).length > 8000
    )
      throw new Error("Event data must be an object <=8000 bytes");
    return this.inbox.accept(inputId, "event.emit", params, () => {
      this.repository.addEvent(inputId, type, data, this.now());
      const works = [];
      for (const rule of this.list()) {
        if (
          !rule.enabled ||
          rule.type !== type ||
          (rule.path !== null && rule.path !== data.path)
        )
          continue;
        const workId = `w_${digest([inputId, rule.id, rule.revision]).slice(0, 24)}`;
        const childId = `event:${digest([inputId, rule.id, rule.revision])}`;
        this.inbox.accept(
          childId,
          "event.delegate",
          { eventId: inputId, ruleId: rule.id, revision: rule.revision },
          () =>
            this.workPort.create(
              workId,
              rule.goal,
              childId,
              "event",
              null,
              undefined,
              rule.resources,
              {
                kind: "event",
                key: `${rule.id}:r${rule.revision}`,
                notify: rule.notify,
                quietOrigin: true,
                eventId: inputId,
                data,
              },
            ),
        );
        this.repository.occurrence(inputId, rule, workId);
        if (rule.notify !== "never")
          this.history.link(this.history.mainId, workId);
        works.push(workId);
      }
      return { eventId: inputId, workIds: works };
    });
  }
  observe(path, sha256) {
    relativePath(path);
    if (sha256 !== null && !/^[a-f0-9]{64}$/.test(sha256))
      throw new Error("Invalid observation hash");
    return this.uow.transaction(() => {
      const old = this.repository.observation(path);
      if (old?.sha256 === sha256) return;
      const revision = (old?.revision ?? 0) + 1;
      this.repository.observe(path, sha256, revision);
      if (old)
        return this.emit(`file:${digest(path)}:r${revision}`, {
          eventType: "file.changed",
          data: { path, sha256, exists: sha256 !== null },
        });
    });
  }
}
