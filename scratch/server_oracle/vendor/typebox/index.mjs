// Minimal offline stand-in for the `typebox` schema builder, covering exactly
// the constructor subset used by the copied upstream `@earendil-works/pi-protocol`
// (protocol.ts): String({minLength,pattern}), Literal, Integer({minimum}),
// Object(properties,{additionalProperties}), Union, Unsafe, Null, Optional.
// Schemas are plain descriptor objects evaluated by value.mjs `Check`.
// Only used to run the upstream client/connection sources for oracle capture;
// the Rust protocol port was validated separately against the real protocol
// behavior in the M6 protocol slice.

const kind = (type, extra) => ({ ...extra, type });

export const Type = {
  String: (options = {}) => kind("string", { minLength: options.minLength, pattern: options.pattern }),
  Literal: (value) => kind("literal", { value }),
  Integer: (options = {}) => kind("integer", { minimum: options.minimum }),
  Null: () => kind("null", {}),
  Unknown: () => kind("unknown", {}),
  Unsafe: (schema) => schema,
  Object: (properties, options = {}) => kind("object", { properties, additionalProperties: options.additionalProperties }),
  Union: (schemas) => kind("union", { schemas }),
  Optional: (schema) => kind("optional", { schema }),
};

export default Type;
