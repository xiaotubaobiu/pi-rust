// Evaluator for the descriptor schemas built by ./index.mjs (see the
// provenance note there). Mirrors the TypeBox Check semantics for the used
// subset: literal equality, string minLength/pattern, integer minimum, strict
// objects (additionalProperties: false), unions, unknown.

function isObjectLike(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function Check(schema, value) {
  switch (schema.type) {
    case "unknown":
      return true;
    case "null":
      return value === null;
    case "literal":
      return value === schema.value;
    case "string": {
      if (typeof value !== "string") return false;
      if (schema.minLength !== undefined && value.length < schema.minLength) return false;
      if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) return false;
      return true;
    }
    case "integer": {
      if (!Number.isInteger(value)) return false;
      if (schema.minimum !== undefined && value < schema.minimum) return false;
      return true;
    }
    case "object": {
      if (!isObjectLike(value)) return false;
      const propertyNames = new Set(Object.keys(schema.properties));
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (propertySchema.type === "optional") {
          if (Object.hasOwn(value, key) && !Check(propertySchema.schema, value[key])) return false;
          continue;
        }
        if (!Object.hasOwn(value, key)) return false;
        if (!Check(propertySchema, value[key])) return false;
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!propertyNames.has(key)) return false;
        }
      }
      return true;
    }
    case "union":
      return schema.schemas.some((candidate) => Check(candidate, value));
    default:
      return false;
  }
}
