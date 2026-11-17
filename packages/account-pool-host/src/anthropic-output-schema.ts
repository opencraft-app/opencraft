type Schema = Record<string, any>;
const object = (v: unknown): v is Schema => !!v && typeof v === 'object' && !Array.isArray(v);
const unsupported = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties']);

/** Messages structured output has a narrower constraint dialect than Responses.
 * Only schema positions are visited (never enum/const/default/examples data).
 * Preserve the caller's schema and structural unions/references. These annotations
 * guide generation; the original schema/authority remains the caller's validator.
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 */
export function anthropicOutputSchema(original: Schema): Schema {
  const schema = structuredClone(original);
  const visit = (node: unknown) => {
    if (!object(node)) return;
    const constraints: Schema = {};
    for (const key of Object.keys(node)) {
      if (unsupported.has(key) || (key === 'minItems' && node[key] !== 0 && node[key] !== 1)) {
        constraints[key] = node[key]; delete node[key];
      }
    }
    if (Object.keys(constraints).length) node.description =
      (typeof node.description === 'string' && node.description ? node.description + '\n' : '') +
      'Output must satisfy these locally validated constraints: ' + JSON.stringify(constraints);
    for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'])
      if (object(node[key])) for (const child of Object.values(node[key])) visit(child);
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems'])
      if (Array.isArray(node[key])) for (const child of node[key]) visit(child);
    for (const key of ['additionalProperties', 'unevaluatedProperties', 'propertyNames', 'contains', 'not', 'if', 'then', 'else', 'additionalItems', 'contentSchema']) visit(node[key]);
    if (Array.isArray(node.items)) for (const child of node.items) visit(child);
    else visit(node.items);
  };
  visit(schema); return schema;
}
