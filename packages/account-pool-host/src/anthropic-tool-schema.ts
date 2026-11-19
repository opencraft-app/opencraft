type Schema = Record<string, any>;
const object = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);

/** Moving a schema under a property also moves document-relative JSON pointers.
 * Visit schema positions only: $ref-shaped data in const/default/examples stays data.
 * A schema with $id introduces its own resource, whose local references stay local.
 */
function nestedSchema(original: Schema): Schema {
  const schema = structuredClone(original);
  const visit = (node: unknown, resource = false) => {
    if (!object(node)) return;
    resource ||= typeof node.$id === "string" && node.$id.length > 0;
    if (!resource) for (const keyword of ["$ref", "$dynamicRef"]) {
      const value = node[keyword];
      if (typeof value === "string" && (value === "#" || value.startsWith("#/"))) node[keyword] = "#/properties/arguments" + value.slice(1);
    }
    for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]) {
      if (object(node[key])) for (const child of Object.values(node[key])) visit(child, resource);
    }
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      if (Array.isArray(node[key])) for (const child of node[key]) visit(child, resource);
    }
    for (const key of ["additionalProperties", "unevaluatedProperties", "propertyNames", "contains", "not", "if", "then", "else", "additionalItems", "contentSchema"]) visit(node[key], resource);
    if (Array.isArray(node.items)) for (const child of node.items) visit(child, resource);
    else visit(node.items, resource);
  };
  visit(schema);
  return schema;
}

/** Preserve root combinator semantics using a reversible wire-only argument envelope. */
export function anthropicToolSchema(schema: Schema): { schema: Schema; enveloped: boolean } {
  const enveloped = ["oneOf", "anyOf", "allOf"].some(key => Object.hasOwn(schema, key));
  return enveloped ? { enveloped, schema: { type: "object", properties: { arguments: nestedSchema(schema) },
    required: ["arguments"], additionalProperties: false } } : { enveloped, schema };
}
