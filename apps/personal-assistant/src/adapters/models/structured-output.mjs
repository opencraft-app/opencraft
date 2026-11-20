import { RECEPTION_LIMITS } from "../../domain/reception-query.mjs";
// Wire schemas constrain syntax, never business authority. Nullable optional
// fields are removed at this boundary before the existing application validators.
const str = { type: "string" },
  int = { type: "integer" },
  bool = { type: "boolean" };
const goalText = {
  type: "string",
  minLength: 1,
  maxLength: 20000,
  pattern: "\\S",
};
const enumeration = (...values) => ({ type: "string", enum: values });
const list = (items) => ({ type: "array", items });
const either = (...anyOf) => ({ anyOf });
function object(properties, optional = []) {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(properties).map(([k, v]) => [
        k,
        optional.includes(k) ? either(v, { type: "null" }) : v,
      ]),
    ),
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
const variant = (kind, properties = {}, optional = []) =>
  object({ kind: enumeration(kind), ...properties }, optional);
const refs = list(str);
const attachment = object({ attachmentId: str, alt: str }, ["alt"]);
const message = either(
  object(
    {
      type: enumeration("text"),
      content: str,
      attachments: list(attachment),
      replyTo: str,
      channel: enumeration("local:main"),
    },
    ["attachments", "replyTo", "channel"],
  ),
  object(
    {
      type: enumeration("attachment"),
      attachmentId: str,
      alt: str,
      replyTo: str,
      channel: enumeration("local:main"),
    },
    ["alt", "replyTo", "channel"],
  ),
);
const completion = object(
  {
    output: enumeration("text", "note"),
    requirements: refs,
    checks: list(
      either(
        variant("material_read", { path: str, sha256: str }, ["sha256"]),
        variant("note_contains", { text: str }),
        variant("note_published"),
      ),
    ),
  },
  ["output", "requirements", "checks"],
);
const replacementCompletion = object(
  Object.fromEntries(
    Object.entries(completion.properties).map(([key, value]) => [
      key,
      value.anyOf.find((s) => s.type !== "null"),
    ]),
  ),
);
const schedule = either(
  variant("once", { at: int }),
  variant(
    "calendar",
    {
      timeZone: str,
      weekdays: list(int),
      hours: list(int),
      minutes: list(int),
    },
    ["weekdays"],
  ),
);
const routine = object(
  {
    text: str,
    startAt: int,
    intervalMs: int,
    schedule,
    expiresAt: int,
    maxRuns: int,
    notify: enumeration("never", "always", "changed"),
    stopWhen: str,
  },
  [
    "startAt",
    "intervalMs",
    "schedule",
    "expiresAt",
    "maxRuns",
    "notify",
    "stopWhen",
  ],
);
const goalTask = object({ key: str, text: str, dependsOn: refs, completion }, [
  "completion",
]);
const goalDefinition = object(
  {
    objective: str,
    criteria: refs,
    priority: int,
    maxParallel: int,
    tasks: list(goalTask),
  },
  ["priority", "maxParallel"],
);
const goalReview = object({
  goalId: str,
  expectedRevision: int,
  evidence: list(object({ criterionId: str, statement: str, resultIds: refs })),
});
const goalPlan = object({
  goalId: str,
  expectedRevision: int,
  tasks: list(goalTask),
});
const commands = [
  variant("goal.rebase", {
    goalId: str,
    expectedRevision: int,
    workId: str,
    expectedWorkRevision: int,
    dependencies: list(object({ workId: str, revision: int })),
  }),
  variant("goal.review", goalReview.properties),
  variant("goal.create", { definition: goalDefinition }),
  variant("goal.extend", {
    goalId: str,
    expectedRevision: int,
    tasks: list(goalTask),
  }),
  ...["goal.reopen", "goal.pause", "goal.resume", "goal.cancel"].map((kind) =>
    variant(kind, { goalId: str, expectedRevision: int }),
  ),
  variant(
    "goal.update",
    { goalId: str, expectedRevision: int, priority: int, maxParallel: int },
    ["priority", "maxParallel"],
  ),
  ...["instruct", "resume"].map((kind) =>
    variant(kind, { workId: str, expectedRevision: int, text: str }),
  ),
  variant("reply", { text: str }),
  variant("clarify", { text: str }),
  variant("delegate", { goal: goalText, completion }, ["completion"]),
  variant("amend", {
    workId: str,
    expectedRevision: int,
    goal: goalText,
    completion: replacementCompletion,
  }),
  variant("cancel", { workId: str, expectedRevision: int }),
  variant("answer", { interactionId: str, expectedRevision: int, text: str }),
  variant("reject", { interactionId: str, expectedRevision: int }),
  variant(
    "remember",
    {
      key: str,
      value: str,
      expectedRevision: int,
      scope: enumeration("agent", "user", "project"),
      project: str,
      memoryKind: enumeration("profile", "log"),
    },
    ["scope", "project", "memoryKind"],
  ),
  variant(
    "forget",
    {
      key: str,
      expectedRevision: int,
      scope: enumeration("agent", "user", "project"),
      project: str,
      memoryKind: enumeration("profile", "log"),
    },
    ["scope", "project", "memoryKind"],
  ),
  variant("project.create", { project: str, name: str, description: str }, [
    "description",
  ]),
  variant("project.join", { project: str }),
  variant("project.leave", { project: str }),
  variant("routine.create", { params: routine }),
  variant("routine.pause", { routineId: str, expectedRevision: int }),
  variant("routine.resume", { routineId: str, expectedRevision: int }),
  variant("routine.update", {
    routineId: str,
    expectedRevision: int,
    definition: routine,
  }),
  variant("send", { message }),
];
const queryFields = {
  "goals.list": {},
  "goal.get": { goalId: str },
  "attachments.list": {},
  "works.list": { state: enumeration("all", "open", "closed"), query: str },
  "work.overview": {},
  "questions.list": { workId: str },
  "work.get": { workId: str },
  "memory.get": { key: str },
  "report.read": { workId: str },
  "history.read": { messageId: str },
  "memory.file.read": { scope: str, project: str, agentId: str, path: str },
  "memory.search": { query: str, match: enumeration("literal", "terms") },
  "memory.files.list": {},
  "history.search": { query: str },
  "materials.list": { source: str, directory: str },
  "material.read": { source: str, path: str },
};
const queries = Object.entries(queryFields).map(([name, fields]) => {
  const read = name.endsWith(".read"),
    paged = !["work.get", "memory.get", "work.overview"].includes(name);
  const optional = [
    ...(name === "questions.list" ? ["workId"] : []),
    "scope",
    "project",
    "agentId",
    "directory",
    "match",
    ...(name === "works.list" ? ["state", "query"] : []),
    ...(paged ? ["limit", read ? "offset" : "after"] : []),
  ];
  return variant("query", {
    name: enumeration(name),
    params: object(
      {
        ...fields,
        ...(paged
          ? {
              limit: {
                type: "integer",
                minimum: 1,
                maximum: read
                  ? RECEPTION_LIMITS.readCharacters
                  : RECEPTION_LIMITS.pageSize,
              },
              [read ? "offset" : "after"]: read ? int : str,
            }
          : {}),
      },
      optional,
    ),
  });
});
const change = either(
  object(
    {
      action: enumeration("create"),
      content: str,
      kind: enumeration("profile", "log"),
      sourceEvidenceIds: refs,
      scope: enumeration("agent", "user", "project"),
      project: str,
    },
    ["scope", "project"],
  ),
  object({
    action: enumeration("update"),
    id: str,
    content: str,
    kind: enumeration("profile", "log"),
    sourceEvidenceIds: refs,
  }),
  object({ action: enumeration("remove"), id: str, sourceEvidenceIds: refs }),
);
const contextItem = object({ text: str, sourceIds: refs });
const schemas = {
  reception: object({
    proposal: either(
      ...commands,
      ...queries,
      variant("batch", {
        commands: list(
          either(
            ...commands.filter((c) => c.properties.kind.enum[0] !== "send"),
          ),
        ),
      }),
      variant(
        "deliver",
        { text: str, message, finishRoutine: bool, goalPlan, goalReview },
        ["text", "message", "finishRoutine", "goalPlan", "goalReview"],
      ),
      variant("silent", { finishRoutine: bool }, ["finishRoutine"]),
      variant("continue", { goal: goalText }),
      variant("blocked", { text: str }),
    ),
  }),
  "memory-propose": object({ changes: list(change) }),
  "memory-verify": object({ approved: bool }),
  "context-summary": object(
    Object.fromEntries(
      ["goals", "constraints", "decisions", "openItems"].map((k) => [
        k,
        list(contextItem),
      ]),
    ),
  ),
};
function contractSchema(kind, input) {
  if (!Object.hasOwn(schemas, kind))
    throw new Error("Unsupported structured inference role");
  const schema = structuredClone(schemas[kind]);
  if (kind === "reception" && input !== undefined) {
    const continuation = new Set(["deliver", "silent", "continue", "blocked"]);
    const isReport = input.source?.kind === "execution-report";
    schema.properties.proposal.anyOf = schema.properties.proposal.anyOf.filter(
      (s) => {
        const decision = s.properties.kind.enum[0];
        return decision === "query" || continuation.has(decision) === isReport;
      },
    );
  }
  return schema;
}

// A branch-neutral wire record avoids deep object unions during constrained
// decoding. It is a syntactic superset, never the command/authority contract.
// Missing branch fields are required nullable slots; the host still checks the
// original tagged union after removing nulls. Only reception needs this shape.
function wireRecord(schema) {
  if (schema.anyOf) return wireUnion(schema.anyOf.map(wireRecord));
  if (schema.type === "object")
    return {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(schema.properties).map(([key, value]) => [
          key,
          wireRecord(value),
        ]),
      ),
    };
  if (schema.type === "array")
    return { ...schema, items: wireRecord(schema.items) };
  return structuredClone(schema);
}
function wireUnion(options) {
  const choices = [
    ...new Map(options.map((s) => [JSON.stringify(s), s])).values(),
  ];
  if (choices.length === 1) return choices[0];
  const objects = choices.filter((s) => s.type === "object");
  if (objects.length > 1) {
    const keys = [
      ...new Set(objects.flatMap((s) => Object.keys(s.properties))),
    ];
    return wireUnion([
      {
        type: "object",
        properties: Object.fromEntries(
          keys.map((key) => [
            key,
            wireUnion(
              objects.map((s) => s.properties[key] ?? { type: "null" }),
            ),
          ]),
        ),
        required: keys,
        additionalProperties: false,
      },
      ...choices.filter((s) => s.type !== "object"),
    ]);
  }
  if (choices.every((s) => s.type === "string" && s.enum))
    return {
      type: "string",
      enum: [...new Set(choices.flatMap((s) => s.enum))],
    };
  return { anyOf: choices };
}
export function outputSchema(kind, input) {
  const schema = contractSchema(kind, input);
  return kind === "reception" ? wireRecord(schema) : schema;
}

// The model selects a discriminator first. The next native turn receives only
// that branch, so conditional requirements become real required fields. The
// catalog comes from the same closed contract used for host decoding.
function receptionBranches(input) {
  return new Map(
    contractSchema("reception", input)
      .properties.proposal.anyOf.filter(
        (s) => s.properties.kind.enum[0] !== "batch",
      )
      .flatMap((s) => {
        const kind = s.properties.kind.enum[0];
        if (kind === "deliver") return deliveryBranches(s);
        return [
          [kind === "query" ? `query:${s.properties.name.enum[0]}` : kind, s],
        ];
      }),
  );
}
// ContinuationDecision permits text OR typed message, and plan OR review.
// Select these shapes before generation rather than silently discarding one.
function deliveryBranches(schema) {
  const required = (field) =>
    schema.properties[field].anyOf.find((s) => s.type !== "null");
  return ["text", "message"].flatMap((channel) =>
    [null, "goalPlan", "goalReview"].map((effect) => [
      ["deliver", channel === "message" ? channel : null, effect]
        .filter(Boolean)
        .join(":"),
      object({
        kind: schema.properties.kind,
        finishRoutine: schema.properties.finishRoutine,
        [channel]:
          channel === "text" ? schema.properties.text : required(channel),
        ...(effect ? { [effect]: required(effect) } : {}),
      }),
    ]),
  );
}
export function routingSchema(input) {
  return object({
    operations: {
      ...list(enumeration(...receptionBranches(input).keys())),
      minItems: 1,
      maxItems: input?.targetWork ? 1 : 4,
    },
  });
}
export function decodeRoutes(text, input) {
  const value = decodeContract(routingSchema(input), text);
  const routes = value.operations;
  if (
    routes.length < 1 ||
    routes.length > (input?.targetWork ? 1 : 4) ||
    (routes.length > 1 &&
      routes.some(
        (r) =>
          r.startsWith("query:") ||
          ["send", "deliver", "silent", "continue", "blocked"].includes(
            r.split(":")[0],
          ),
      ))
  )
    throw new StructuredOutputError("routing", {
      code: "invalid_batch",
      path: "$.operations",
    });
  return routes;
}
export function selectedSchema(routes, input) {
  // Revalidate even caller-supplied selections; report source never gains user commands.
  decodeRoutes(JSON.stringify({ operations: routes }), input);
  const branches = receptionBranches(input);
  return routes.length === 1
    ? object({ proposal: branches.get(routes[0]) })
    : object(
        Object.fromEntries(
          routes.map((r, i) => [`command${i + 1}`, branches.get(r)]),
        ),
      );
}
export function decodeSelected(text, routes, input) {
  const value = decodeContract(selectedSchema(routes, input), text);
  return routes.length === 1
    ? value.proposal
    : {
        kind: "batch",
        commands: routes.map((_, i) => value[`command${i + 1}`]),
      };
}
function decodeContract(schema, text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StructuredOutputError("json", {
      code: "invalid_json",
      path: "$",
    });
  }
  if (!validateCanonical(schema, value))
    throw new StructuredOutputError(
      "selected_contract",
      schemaIssue(schema, value),
    );
  return omitNulls(value);
}
// Small validator for precisely this schema vocabulary; no repair or coercion.
export function validateOutput(schema, value) {
  if (schema.anyOf) return schema.anyOf.some((s) => validateOutput(s, value));
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case "null":
      return value === null;
    case "string":
      return (
        typeof value === "string" &&
        value.length >= (schema.minLength ?? 0) &&
        value.length <= (schema.maxLength ?? Infinity) &&
        (schema.pattern === undefined ||
          new RegExp(schema.pattern, "u").test(value))
      );
    case "integer":
      return (
        Number.isSafeInteger(value) &&
        (schema.minimum === undefined || value >= schema.minimum) &&
        (schema.maximum === undefined || value <= schema.maximum)
      );
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return (
        Array.isArray(value) &&
        value.every((v) => validateOutput(schema.items, v))
      );
    case "object":
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        schema.required.every((k) => Object.hasOwn(value, k)) &&
        Object.keys(value).every(
          (k) =>
            Object.hasOwn(schema.properties, k) &&
            validateOutput(schema.properties[k], value[k]),
        )
      );
    default:
      return false;
  }
}
function omitNulls(value) {
  if (Array.isArray(value)) return value.map(omitNulls);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, omitNulls(v)]),
    );
  return value;
}
// The wire makes optionals explicit nulls; the canonical protocol omits them.
// Non-null fields belonging to a different branch remain invalid, as do unknown
// fields. No coercion, guessed intent or command correction occurs here.
function validateCanonical(schema, value) {
  if (schema.anyOf)
    return schema.anyOf.some((s) => validateCanonical(s, value));
  if (schema.type === "object")
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      schema.required.every(
        (key) =>
          Object.hasOwn(value, key) ||
          validateOutput(schema.properties[key], null),
      ) &&
      Object.keys(value).every(
        (key) =>
          Object.hasOwn(schema.properties, key) &&
          validateCanonical(schema.properties[key], value[key]),
      )
    );
  if (schema.type === "array")
    return (
      Array.isArray(value) &&
      value.every((v) => validateCanonical(schema.items, v))
    );
  return validateOutput(schema, value);
}
// Diagnostic-only traversal. Acceptance stays with the validators above. Paths
// contain schema-owned names only: arbitrary model keys/values never enter logs.
function schemaIssue(schema, value) {
  const names = new Set();
  const collect = (s) => {
    for (const [key, child] of Object.entries(s.properties ?? {})) {
      names.add(key);
      collect(child);
    }
    s.anyOf?.forEach(collect);
    if (s.items) collect(s.items);
  };
  collect(schema);
  let budget = 256;
  const visit = (s, v, path = "$", depth = 0) => {
    const issue = (code, at = path) => ({ code, path: at.slice(0, 160) });
    if (--budget < 0 || depth > 32) return issue("diagnostic_limit");
    if (s.anyOf) {
      if (s.anyOf.some((branch) => validateCanonical(branch, v))) return null;
      let branches = s.anyOf;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        branches = branches.filter((b) => b.type === "object");
        for (const key of ["kind", "name", "action", "type"]) {
          const tagged = branches.filter((b) => b.properties[key]?.enum);
          if (!tagged.length) continue;
          const matches = tagged.filter((b) =>
            b.properties[key].enum.includes(v[key]),
          );
          if (matches.length) branches = matches;
          else if (tagged.length === branches.length)
            return issue(
              Object.hasOwn(v, key) ? "enum" : "required",
              `${path}.${key}`,
            );
        }
      } else {
        branches = branches.filter((b) => b.type !== "null" || v === null);
      }
      return branches.length
        ? visit(branches[0], v, path, depth + 1)
        : issue("union");
    }
    if (s.enum && !s.enum.includes(v)) return issue("enum");
    if (s.type === "object") {
      if (v === null || typeof v !== "object" || Array.isArray(v))
        return issue("type");
      for (const key of s.required) {
        if (!Object.hasOwn(v, key) && !validateOutput(s.properties[key], null))
          return issue("required", `${path}.${key}`);
      }
      for (const key of Object.keys(v)) {
        if (!Object.hasOwn(s.properties, key))
          return issue(
            "unexpected",
            `${path}.${names.has(key) ? key : "<unknown>"}`,
          );
        const found = visit(
          s.properties[key],
          v[key],
          `${path}.${key}`,
          depth + 1,
        );
        if (found) return found;
      }
      return null;
    }
    if (s.type === "array") {
      if (!Array.isArray(v)) return issue("type");
      for (const item of v) {
        const found = visit(s.items, item, `${path}[]`, depth + 1);
        if (found) return found;
      }
      return null;
    }
    return validateOutput(s, v)
      ? null
      : issue(
          s.type === "string" && typeof v === "string"
            ? "text_constraint"
            : "type",
        );
  };
  return visit(schema, value) ?? { code: "wire_shape", path: "$" };
}
export class StructuredOutputError extends Error {
  constructor(stage, issue) {
    super(
      `Structured output does not match the requested ${stage === "command_contract" ? "command contract" : "schema"} (${stage}: ${issue.code} at ${issue.path})`,
    );
    this.name = "StructuredOutputError";
    this.diagnostic = Object.freeze({ stage, ...issue });
  }
}
export function decodeOutput(kind, text, input) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StructuredOutputError("json", {
      code: "invalid_json",
      path: "$",
    });
  }
  const contract = contractSchema(kind, input);
  // Accept canonical/older branch records too: newly introduced nullable slots
  // may be absent. Required fields, foreign non-null slots and unknown keys
  // still pass the exact tagged-union validator; nothing is inferred/coerced.
  if (
    !validateOutput(outputSchema(kind, input), value) &&
    !validateCanonical(contract, value)
  )
    throw new StructuredOutputError(
      "wire",
      schemaIssue(contract, omitNulls(value)),
    );
  const canonical = omitNulls(value);
  if (!validateCanonical(contract, canonical))
    throw new StructuredOutputError(
      "command_contract",
      schemaIssue(contract, canonical),
    );
  return kind === "reception" ? canonical.proposal : canonical;
}
