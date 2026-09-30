// Stub for node:crypto intercepted by loader.mjs: upstream generateId() does
// `randomUUID().slice(0, 8)`; the Rust port mints ids through an injectable
// seam, so the oracle feeds it the same deterministic sequence the Rust tests
// emit ("00000001", "00000002", ... — 8 hex-shaped chars, collision-free).
import { nextEntryId } from "./id_state.mjs";

export function randomUUID() {
  return nextEntryId();
}

export default {};
