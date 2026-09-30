//! Return whether a value is finite strict JSON with plain objects and no
//! cycles. Port of `packages/chord/src/json.ts` (upstream sha256
//! `d94a2f33d6c83fc022580466700d34cd1bca21003d567522f58b38902e1806fa`).
//!
//! In a JS host the predicate guards against the extra values objects can
//! carry: `undefined` properties, non-finite numbers, typed arrays, class
//! instances, and reference cycles. Over owned [`JsonValue`]
//! (`serde_json::Value`) trees most of those are unrepresentable by
//! construction — numbers are always finite, arrays are real arrays, objects
//! are plain maps, and cycles cannot exist in an owned tree. What survives is
//! the depth bound: upstream rejects nesting deeper than 512
//! (`json.ts:8-9`), and the port keeps that so a stream validated here
//! matches what the TypeScript validator accepts.

use crate::chord::types::JsonValue;

/// Depth limit shared with the upstream validator (`json.ts:8`).
const MAX_DEPTH: usize = 512;

/// `isJsonValue(value)` (`json.ts:4-6`).
pub fn is_json_value(value: &JsonValue) -> bool {
    check(value, 0)
}

fn check(value: &JsonValue, depth: usize) -> bool {
    if depth > MAX_DEPTH {
        return false;
    }
    match value {
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_) => true,
        JsonValue::Array(items) => {
            for item in items {
                if !check(item, depth + 1) {
                    return false;
                }
            }
            true
        }
        JsonValue::Object(object) => {
            for item in object.values() {
                if !check(item, depth + 1) {
                    return false;
                }
            }
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checks_strict_json() {
        // Upstream json.test.ts cases representable over owned JSON values.
        assert!(is_json_value(&json!({ "nested": [1, true, null] })));
        // Non-finite numbers, `undefined` properties, typed arrays and
        // cycles cannot be constructed as a serde_json::Value — compile-time
        // guarantees in the port (see module docs).
        let cyclic = {
            // A cycle cannot exist; the closest representable check is a
            // deeply nested structure within and beyond the depth bound.
            let mut value = json!(0);
            for _ in 0..512 {
                value = json!([value]);
            }
            value
        };
        assert!(is_json_value(&cyclic));
        let mut too_deep = json!(0);
        for _ in 0..513 {
            too_deep = json!([too_deep]);
        }
        assert!(!is_json_value(&too_deep));
        assert!(is_json_value(&json!(null)));
        assert!(is_json_value(&json!([])));
        assert!(is_json_value(&json!({})));
    }
}
