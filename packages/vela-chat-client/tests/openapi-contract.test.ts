import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const openapi = readFileSync(
  new URL("../../../public/openapi/velachat.v1.yaml", import.meta.url),
  "utf8",
);
const clientSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const openapiLines = openapi.split("\n");
const schemasStart = openapiLines.findIndex((line) => line === "  schemas:");

test("client enum allowlists stay aligned with the OpenAPI wire contract", () => {
  assertSetEqual(openapiSchemaEnum("BackendKind"), clientStringSet("backendKinds"));
  assertSetEqual(openapiSchemaEnum("ViewWindowDirection"), clientStringSet("viewWindowDirections"));
  assertSetEqual(openapiSchemaEnum("SessionStatus"), clientStringSet("sessionStatuses"));
  assertSetEqual(openapiSchemaEnum("RequestStatus"), clientStringSet("requestStatuses"));
  assertSetEqual(openapiSchemaEnum("PermissionMode"), clientStringSet("permissionModes"));

  assertSetEqual(
    openapiSchemaPropertyEnum("ChatTranscriptRow", "kind"),
    clientStringSet("transcriptRowKinds"),
  );
  assertSetEqual(
    openapiSchemaPropertyEnum("ChatTranscriptRow", "status"),
    clientStringSet("transcriptRowStatuses"),
  );
  assertSetEqual(
    openapiSchemaPropertyEnum("TranscriptPart", "type"),
    clientStringSet("transcriptPartTypes"),
  );

  assertSetEqual(
    openapiSchemaPropertyEnum("ActivityShelfItem", "kind"),
    clientStringSet("activityItemKinds"),
  );
  assertSetEqual(
    openapiSchemaPropertyEnum("ActivityShelfItem", "status"),
    clientStringSet("activityItemStatuses"),
  );
  assertSetEqual(openapiSchemaPropertyEnum("AgentRequest", "type"), clientStringSet("requestTypes"));
});

test("client activity detail allowlist covers the OpenAPI detail union", () => {
  const openapiDetailTypes = [
    ...openapiSchemaPropertyEnum("ActivityShellToolDetail", "type"),
    ...openapiSchemaPropertyEnum("ActivityFileToolDetail", "type"),
    ...openapiSchemaPropertyEnum("ActivitySearchToolDetail", "type"),
    ...openapiSchemaPropertyEnum("ActivityFetchToolDetail", "type"),
    ...openapiSchemaPropertyEnum("ActivityGenericToolDetail", "type"),
  ];

  assertSetEqual(openapiDetailTypes, clientStringSet("activityDetailTypes"));
});

function openapiSchemaEnum(schemaName: string) {
  return enumValues(openapiSchemaBlock(schemaName));
}

function openapiSchemaPropertyEnum(schemaName: string, propertyName: string) {
  return enumValues(openapiSchemaPropertyBlock(schemaName, propertyName));
}

function openapiSchemaBlock(schemaName: string) {
  assert.notEqual(schemasStart, -1, "OpenAPI components.schemas section is missing");
  const start = openapiLines.findIndex(
    (line, index) => index > schemasStart && line === `    ${schemaName}:`,
  );
  assert.notEqual(start, -1, `OpenAPI schema ${schemaName} is missing`);

  let end = openapiLines.length;
  for (let index = start + 1; index < openapiLines.length; index += 1) {
    if (/^    [A-Za-z0-9][A-Za-z0-9_]*:$/.test(openapiLines[index] ?? "")) {
      end = index;
      break;
    }
  }

  return openapiLines.slice(start, end).join("\n");
}

function openapiSchemaPropertyBlock(schemaName: string, propertyName: string) {
  const lines = openapiSchemaBlock(schemaName).split("\n");
  const start = lines.findIndex((line) => line === `        ${propertyName}:`);
  assert.notEqual(start, -1, `OpenAPI schema ${schemaName}.${propertyName} is missing`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^        [A-Za-z0-9_]+:$/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join("\n");
}

function enumValues(block: string) {
  const inline = block.match(/enum: \[([^\]]+)\]/);
  if (inline) {
    return inline[1]!
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  const blockEnum = block.match(/\n\s+enum:\n([\s\S]*)/);
  assert.ok(blockEnum, `No enum found in block:\n${block}`);
  return [...blockEnum[1]!.matchAll(/^\s+-\s*([^\s#]+)/gm)].map((match) => match[1]!);
}

function clientStringSet(setName: string) {
  const declarationIndex = clientSource.indexOf(`const ${setName}`);
  assert.notEqual(declarationIndex, -1, `client set ${setName} is missing`);
  const arrayStart = clientSource.indexOf("[", declarationIndex);
  assert.notEqual(arrayStart, -1, `client set ${setName} has no array literal`);
  const arrayLiteral = bracketLiteral(clientSource, arrayStart);
  return [...arrayLiteral.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

function bracketLiteral(source: string, start: number) {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  throw new Error("Unterminated array literal");
}

function assertSetEqual(actual: string[], expected: string[]) {
  assert.deepEqual([...new Set(actual)].sort(), [...new Set(expected)].sort());
}
