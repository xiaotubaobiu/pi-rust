// Oracle capture for the M6 chord services surface (wire protocol, state
// codec, provider, replicated state, endpoint, defineService, isJsonValue)
// plus the delta op-validation tables. Canonical JSON = compact with
// recursively sorted object keys (matches serde_json BTreeMap serialization).
import { createHash } from "node:crypto";
import { assertValidOp, assertValidWireOp } from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/chord/src/delta/index.ts";
import { BACKGROUND_CONTEXT } from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/chord/src/context/index.ts";
import { isJsonValue } from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/chord/src/json.ts";
import {
  createServiceCatalogueCall,
  createServiceStateDecoder,
  createServiceStateEncoder,
  createServiceSubscribeCall,
  createServiceUnsubscribeCall,
  decodeServiceControlCall,
  defineService,
  parseServiceCall,
  parseServiceCatalogue,
  parseServiceProviderUpdate,
  parseServiceSubscriptionSnapshot,
  parseWireServiceProviderUpdate,
  parseWireServiceSubscriptionSnapshot,
  createRemoteServiceEndpoint,
  RemoteServiceProvider,
  replicatedState,
} from "file:///C:/Users/13063/Desktop/code/agent%20work/pi/packages/chord/src/index.ts";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const canon = (value) =>
  JSON.stringify(value, (_key, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const out = {};
      for (const key of Object.keys(v).sort()) out[key] = v[key];
      return out;
    }
    return v;
  });
const tryCanon = (fn) => {
  try {
    return { ok: true, value: canon(fn()) };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
};
const tryRun = (fn) => {
  try {
    fn();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
};
const tryRunAsync = async (fn) => {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
};

// ── isJsonValue ──────────────────────────────────────────────────────────────
const cyclic = {};
cyclic.self = cyclic;
const jsonChecks = [
  { name: "nested_ok", value: { nested: [1, true, null] } },
  { name: "undefined_prop", value: { omitted: undefined } },
  { name: "typed_array", value: new Uint8Array([1]) },
  { name: "infinity", value: Number.POSITIVE_INFINITY },
  { name: "cyclic", value: cyclic },
  { name: "depth_513", value: (() => {
      let v = 0;
      for (let i = 0; i < 513; i++) v = [v];
      return v;
    })() },
  { name: "depth_512", value: (() => {
      let v = 0;
      for (let i = 0; i < 512; i++) v = [v];
      return v;
    })() },
];
const jsonResults = jsonChecks.map(({ name, value }) => ({ name, result: isJsonValue(value) }));

// ── op validation tables ─────────────────────────────────────────────────────
const decodedOps = [
  ["r", { a: 1 }],
  ["s", ["a"], 1],
  ["d", ["a"]],
  ["a", ["a"], "x"],
  ["t", ["a"], 2],
  ["p", ["a"], 0, 0, []],
];
const wireOnlyOps = [
  ["s", 1],
  ["d"],
  ["a", "x"],
  ["t", 2],
  ["p", 0, 0, []],
  ["#", 0, ["a"]],
  ["s", 0, 1],
];
const invalidOps = [
  { name: "unknown_verb", op: ["ZZZ", ["a"], 9] },
  { name: "p_items_not_array", op: ["p", ["xs"], 0, 0, "not-an-array"] },
  { name: "string_path", op: ["s", "a", 9] },
  { name: "non_tuple_object", op: { op: "s" } },
  { name: "null_op", op: null },
  { name: "negative_truncate", op: ["t", ["a"], -1] },
  { name: "constructor_walk", op: ["s", ["constructor", "prototype", "gadget"], true] },
];
const validationRows = [];
for (const op of decodedOps) {
  validationRows.push({
    name: `decoded_${JSON.stringify(op[0])}_${op.length}`,
    op: canon(op),
    opValid: tryRun(() => assertValidOp(op)).ok,
    wireValid: tryRun(() => assertValidWireOp(op)).ok,
  });
}
for (const op of wireOnlyOps) {
  validationRows.push({
    name: `wire_${JSON.stringify(op[0])}_${op.length}`,
    op: canon(op),
    opValid: tryRun(() => assertValidOp(op)).ok,
    wireValid: tryRun(() => assertValidWireOp(op)).ok,
  });
}
for (const { name, op } of invalidOps) {
  validationRows.push({
    name: `invalid_${name}`,
    op: canon(op),
    opValid: tryRun(() => assertValidOp(op)).ok,
    wireValid: tryRun(() => assertValidWireOp(op)).ok,
  });
}

// ── wire control calls and parsing ───────────────────────────────────────────
const wireRows = [];
wireRows.push({ name: "catalogue_call", ...tryCanon(() => createServiceCatalogueCall()) });
wireRows.push({
  name: "subscribe_call",
  ...tryCanon(() => createServiceSubscribeCall("subscription-1", "pi.models", "singleton")),
});
wireRows.push({ name: "unsubscribe_call", ...tryCanon(() => createServiceUnsubscribeCall("subscription-1")) });
wireRows.push({ name: "decode_catalogue", ...tryCanon(() => decodeServiceControlCall(createServiceCatalogueCall())) });
wireRows.push({
  name: "decode_subscribe",
  ...tryCanon(() => decodeServiceControlCall(createServiceSubscribeCall("subscription-1", "pi.models", "singleton"))),
});
wireRows.push({
  name: "decode_unsubscribe",
  ...tryCanon(() => decodeServiceControlCall(createServiceUnsubscribeCall("subscription-1"))),
});
wireRows.push({
  name: "decode_with_instance",
  ...tryCanon(() =>
    decodeServiceControlCall({
      serviceId: "$chord.service",
      member: "catalogue",
      instance: { key: "k", generation: 1 },
      args: [],
    }),
  ),
});
wireRows.push({
  name: "decode_subscribe_bad_mode",
  ...tryCanon(() => decodeServiceControlCall({ serviceId: "$chord.service", member: "subscribe", args: ["s1", "svc", "other"] })),
});
wireRows.push({
  name: "parse_call_ok",
  ...tryCanon(() =>
    parseServiceCall({
      serviceId: "pi.question-dialog",
      instance: { key: "invocation-1", generation: 2 },
      member: "submit",
      args: [{ outcome: "selected", index: 0 }],
    }),
  ),
});
wireRows.push({
  name: "parse_call_extra_key",
  ...tryCanon(() => parseServiceCall({ serviceId: "pi.models", member: "list", args: [], extra: true })),
});
wireRows.push({
  name: "parse_call_empty_id",
  ...tryCanon(() => parseServiceCall({ serviceId: "", member: "list", args: [] })),
});
wireRows.push({
  name: "parse_catalogue_ok",
  ...tryCanon(() =>
    parseServiceCatalogue([
      { serviceId: "pi.models", mode: "singleton" },
      { serviceId: "pi.dialogs", mode: "keyed" },
    ]),
  ),
});
wireRows.push({
  name: "parse_catalogue_bad_mode",
  ...tryCanon(() => parseServiceCatalogue([{ serviceId: "pi.models", mode: "unknown" }])),
});
wireRows.push({
  name: "parse_catalogue_duplicate",
  ...tryCanon(() =>
    parseServiceCatalogue([
      { serviceId: "pi.models", mode: "singleton" },
      { serviceId: "pi.models", mode: "singleton" },
    ]),
  ),
});
wireRows.push({
  name: "parse_update_sequence_zero",
  ...tryCanon(() => parseServiceProviderUpdate({ type: "state", member: "state", sequence: 0, ops: [] })),
});
wireRows.push({
  name: "parse_wire_update_bad_op",
  ...tryCanon(() => parseWireServiceProviderUpdate({ type: "state", member: "state", sequence: 1, ops: [["?", 0]] })),
});
wireRows.push({
  name: "parse_update_unavailable",
  ...tryCanon(() => parseServiceProviderUpdate({ type: "unavailable" })),
});
wireRows.push({
  name: "parse_update_unavailable_extra",
  ...tryCanon(() => parseServiceProviderUpdate({ type: "unavailable", extra: 1 })),
});
wireRows.push({
  name: "parse_update_bad_type",
  ...tryCanon(() => parseServiceProviderUpdate({ type: "other" })),
});
wireRows.push({
  name: "parse_address_generation_zero",
  ...tryCanon(() => parseServiceCall({ serviceId: "svc", member: "m", args: [], instance: { key: "k", generation: 0 } })),
});

// ── snapshot/update validation + state codec ─────────────────────────────────
const codecRows = [];
const snapshot = {
  serviceId: "pi.models",
  mode: "singleton",
  instances: [
    {
      members: [{ name: "state", kind: "state", sequence: 0, ops: [["r", { revision: 1 }]] }],
    },
  ],
};
codecRows.push({ name: "parse_snapshot", ...tryCanon(() => parseServiceSubscriptionSnapshot(snapshot)) });
{
  const encoder = createServiceStateEncoder();
  const wireSnapshot = encoder.encodeSnapshot(snapshot);
  codecRows.push({ name: "encode_snapshot", ...tryCanon(() => parseWireServiceSubscriptionSnapshot(wireSnapshot)) });
  const update = { type: "state", member: "state", sequence: 1, ops: [["s", ["revision"], 2]] };
  codecRows.push({ name: "parse_update", ...tryCanon(() => parseServiceProviderUpdate(update)) });
  codecRows.push({ name: "encode_update", ...tryCanon(() => parseWireServiceProviderUpdate(encoder.encodeUpdate(update))) });
}
{
  const enc = createServiceStateEncoder();
  const dec = createServiceStateDecoder();
  const snap = {
    serviceId: "pi.models",
    mode: "singleton",
    instances: [
      {
        members: [{ name: "state", kind: "state", sequence: 0, ops: [["r", { revision: 0 }]] }],
      },
    ],
  };
  const decoded = dec.decodeSnapshot(enc.encodeSnapshot(snap));
  codecRows.push({ name: "pair_snapshot_roundtrip", ...tryCanon(() => decoded) });
  const first = { type: "state", member: "state", sequence: 1, ops: [["s", ["revision"], 1]] };
  const second = { type: "state", member: "state", sequence: 2, ops: [["s", ["revision"], 2]] };
  const firstWire = enc.encodeUpdate(first);
  const secondWire = enc.encodeUpdate(second);
  codecRows.push({ name: "pair_first_wire", ...tryCanon(() => firstWire) });
  codecRows.push({ name: "pair_second_wire", ...tryCanon(() => secondWire) });
  codecRows.push({ name: "pair_first_decoded", ...tryCanon(() => dec.decodeUpdate(firstWire)) });
  codecRows.push({ name: "pair_second_decoded", ...tryCanon(() => dec.decodeUpdate(secondWire)) });
}
{
  const snap = {
    serviceId: "pi.states",
    mode: "singleton",
    instances: [
      {
        members: [
          { name: "left", kind: "state", sequence: 0, ops: [["r", { revision: 0 }]] },
          { name: "right", kind: "state", sequence: 0, ops: [["r", { revision: 0 }]] },
        ],
      },
    ],
  };
  const firstEncoder = createServiceStateEncoder();
  const firstDecoder = createServiceStateDecoder();
  const secondEncoder = createServiceStateEncoder();
  const secondDecoder = createServiceStateDecoder();
  firstDecoder.decodeSnapshot(firstEncoder.encodeSnapshot(snap));
  secondDecoder.decodeSnapshot(secondEncoder.encodeSnapshot(snap));
  const update = (member, sequence, revision) => ({
    type: "state",
    member,
    sequence,
    ops: [["s", ["revision"], revision]],
  });
  const firstLeft = firstEncoder.encodeUpdate(update("left", 1, 1));
  const firstRight = firstEncoder.encodeUpdate(update("right", 1, 1));
  const secondLeft = firstEncoder.encodeUpdate(update("left", 2, 2));
  const secondRight = firstEncoder.encodeUpdate(update("right", 2, 2));
  codecRows.push({ name: "isolate_first_left", ...tryCanon(() => firstLeft) });
  codecRows.push({ name: "isolate_first_right", ...tryCanon(() => firstRight) });
  codecRows.push({ name: "isolate_second_left", ...tryCanon(() => secondLeft) });
  codecRows.push({ name: "isolate_second_right", ...tryCanon(() => secondRight) });
  codecRows.push({ name: "isolate_first_left_dec", ...tryCanon(() => firstDecoder.decodeUpdate(firstLeft)) });
  codecRows.push({ name: "isolate_first_right_dec", ...tryCanon(() => firstDecoder.decodeUpdate(firstRight)) });
  codecRows.push({ name: "isolate_second_left_dec", ...tryCanon(() => firstDecoder.decodeUpdate(secondLeft)) });
  codecRows.push({ name: "isolate_second_right_dec", ...tryCanon(() => firstDecoder.decodeUpdate(secondRight)) });
  const independentLeft = secondEncoder.encodeUpdate(update("left", 1, 1));
  codecRows.push({ name: "isolate_independent_left", ...tryCanon(() => independentLeft) });
  codecRows.push({ name: "isolate_independent_left_dec", ...tryCanon(() => secondDecoder.decodeUpdate(independentLeft)) });
  const leftBase = { type: "state", member: "left", sequence: 3, ops: [["r", { revision: 3 }]] };
  codecRows.push({ name: "isolate_left_base_dec", ...tryCanon(() => firstDecoder.decodeUpdate(firstEncoder.encodeUpdate(leftBase))) });
  const thirdRight = firstEncoder.encodeUpdate(update("right", 3, 3));
  codecRows.push({ name: "isolate_third_right", ...tryCanon(() => thirdRight) });
  codecRows.push({ name: "isolate_third_right_dec", ...tryCanon(() => firstDecoder.decodeUpdate(thirdRight)) });
}
{
  const enc = createServiceStateEncoder();
  const dec = createServiceStateDecoder();
  const snap = { serviceId: "pi.dialogs", mode: "keyed", instances: [] };
  codecRows.push({ name: "keyed_snapshot_roundtrip", ...tryCanon(() => dec.decodeSnapshot(enc.encodeSnapshot(snap))) });
  const address = { key: "dialog-1", generation: 1 };
  const spawned = {
    type: "spawned",
    instance: {
      instance: address,
      members: [{ name: "request", kind: "state", sequence: 0, ops: [["r", { value: 0 }]] }],
    },
  };
  codecRows.push({ name: "keyed_spawned_dec", ...tryCanon(() => dec.decodeUpdate(enc.encodeUpdate(spawned))) });
  const update = { type: "state", instance: address, member: "request", sequence: 1, ops: [["s", ["value"], 1]] };
  codecRows.push({ name: "keyed_update_dec", ...tryCanon(() => dec.decodeUpdate(enc.encodeUpdate(update))) });
  const closed = { type: "closed", instance: address };
  codecRows.push({ name: "keyed_closed_dec", ...tryCanon(() => dec.decodeUpdate(enc.encodeUpdate(closed))) });
  codecRows.push({
    name: "keyed_unknown_after_close",
    ...tryCanon(() => enc.encodeUpdate({ ...update, sequence: 2 })),
  });
}

// ── defineService ────────────────────────────────────────────────────────────
const serviceRows = [];
{
  const Models = defineService("test.models");
  const local = defineService("test.local", { local: true });
  serviceRows.push({ name: "models_local", result: Models.local });
  serviceRows.push({ name: "local_flag", result: local.local });
  serviceRows.push({ name: "models_canonical", ...tryCanon(() => Models) });
  serviceRows.push({ name: "local_canonical", ...tryCanon(() => local) });
  serviceRows.push({
    name: "reserved_id",
    ...tryRun(() => defineService("$chord.internal", { local: true })),
  });
  serviceRows.push({ name: "empty_id", ...tryRun(() => defineService("")) });
}

// ── mutable replicated state ─────────────────────────────────────────────────
const stateRows = [];
{
  const initial = { revision: 0, selected: null };
  const state = replicatedState(initial);
  const deliveries = [];
  const values = [];
  const unsubscribe = state.subscribe((value, _context, delivery) => {
    deliveries.push(delivery.kind);
    values.push(canon(value));
  });
  stateRows.push({ name: "state_initial_value", ...tryCanon(() => state.value) });
  state.state.selected = { modelId: "one", provider: "test" };
  state.state.revision = 1;
  state.publish(BACKGROUND_CONTEXT);
  stateRows.push({ name: "state_after_update", ...tryCanon(() => state.value) });
  stateRows.push({ name: "state_deliveries", result: deliveries });
  stateRows.push({ name: "state_values", result: values });
  unsubscribe();
}
{
  const state = replicatedState({ value: 1 });
  const deliveries = [];
  state.subscribe((_value, _context, delivery) => deliveries.push(delivery));
  state.state.value = 2;
  state.state.value = 1;
  state.publish(BACKGROUND_CONTEXT);
  stateRows.push({ name: "redundant_value", ...tryCanon(() => state.value) });
  stateRows.push({ name: "redundant_deliveries", result: deliveries });
}
{
  const state = replicatedState({ entries: [{ id: "one" }] });
  const first = [];
  state.subscribe((value) => first.push(canon(value)));
  state.state.entries.push({ id: "two" });
  const second = [];
  state.subscribe((value) => second.push(canon(value)));
  stateRows.push({ name: "hydrate_flush_first", result: first });
  stateRows.push({ name: "hydrate_flush_second", result: second });
}

// ── provider ─────────────────────────────────────────────────────────────────
const providerRows = [];
{
  const Counter = defineService("test.counter");
  const provider = new RemoteServiceProvider([Counter]);
  const state = replicatedState({ value: 0 });
  provider.provide(Counter, { state });
  const endpoint = createRemoteServiceEndpoint(provider);
  const updates = [];
  const publish = (_subscriptionId, update) => {
    updates.push(canon(update));
  };
  const catalogue = await endpoint.invoke(createServiceCatalogueCall(), publish, BACKGROUND_CONTEXT);
  providerRows.push({ name: "endpoint_catalogue", ...tryCanon(() => catalogue) });
  const snap = await endpoint.invoke(
    createServiceSubscribeCall("subscription-1", Counter.id, "singleton"),
    publish,
    BACKGROUND_CONTEXT,
  );
  providerRows.push({ name: "endpoint_subscribe_snapshot", ...tryCanon(() => snap) });
  state.state.value = 1;
  state.publish(BACKGROUND_CONTEXT);
  providerRows.push({ name: "endpoint_updates_after_publish", result: [...updates] });
  endpoint.dispose();
  state.state.value = 2;
  state.publish(BACKGROUND_CONTEXT);
  providerRows.push({ name: "endpoint_updates_after_dispose_len", result: updates.length });
  provider.dispose();
}
{
  const Models = defineService("test.models");
  const provider = new RemoteServiceProvider([Models]);
  providerRows.push({ name: "provider_catalogue", ...tryCanon(() => provider.catalogue) });
  const local = defineService("test.local", { local: true });
  providerRows.push({ name: "provider_rejects_local", ...tryRun(() => new RemoteServiceProvider([local])) });
  const state = replicatedState({ revision: 0, selected: null });
  provider.provide(Models, {
    state,
    async select(_model, _context) {
      state.state.revision += 1;
      state.publish(BACKGROUND_CONTEXT);
    },
  });
  const updates = [];
  const raw = provider.subscribe(Models.id, "singleton", (update) => updates.push(canon(update)));
  providerRows.push({ name: "raw_snapshot_members", ...tryCanon(() => raw.snapshot.instances[0].members) });
  raw.activate();
  await provider.invoke(
    { serviceId: Models.id, member: "select", args: [{ modelId: "one", provider: "test" }] },
    BACKGROUND_CONTEXT,
  );
  providerRows.push({ name: "provider_updates_after_invoke", result: [...updates] });
  const late = provider.subscribe(Models.id, "singleton", () => {});
  providerRows.push({ name: "late_snapshot_members", ...tryCanon(() => late.snapshot.instances[0].members) });
  late.close();
  raw.close();
  provider.dispose();
}
{
  const Models = defineService("test.models");
  const provider = new RemoteServiceProvider([Models]);
  provider.provide(Models, {
    state: replicatedState({ revision: 1, selected: null }),
    async select() {},
  });
  provider.withdraw(Models);
  providerRows.push({
    name: "withdraw_then_invoke",
    ...(await tryRunAsync(() =>
      provider.invoke({ serviceId: Models.id, member: "select", args: [] }, BACKGROUND_CONTEXT),
    )),
  });
  provider.replace(Models, {
    state: replicatedState({ revision: 2, selected: null }),
    async select() {},
  });
  providerRows.push({ name: "replace_ok", ok: true });
  providerRows.push({
    name: "replace_shape_mismatch_missing_member",
    ...tryRun(() =>
      provider.replace(Models, {
        async select() {},
      }),
    ),
  });
  providerRows.push({
    name: "replace_shape_mismatch_kind_change",
    ...tryRun(() =>
      provider.replace(Models, {
        async state() {},
        async select() {},
      }),
    ),
  });
  provider.dispose();
}
{
  const Models = defineService("test.models");
  const provider = new RemoteServiceProvider([Models]);
  provider.provide(Models, {
    state: replicatedState({ revision: 1, selected: null }),
    async select() {},
  });
  let delivered = 0;
  let failure = null;
  const failing = provider.subscribe(Models.id, "singleton", () => {
    throw new Error("listener failed");
  });
  const succeeding = provider.subscribe(Models.id, "singleton", () => {
    delivered += 1;
  });
  failing.activate();
  succeeding.activate();
  try {
    provider.replace(Models, {
      state: replicatedState({ revision: 2, selected: null }),
      async select() {},
    });
  } catch (error) {
    failure = String(error.message);
  }
  providerRows.push({ name: "listener_failure_message", result: failure });
  providerRows.push({ name: "listener_failure_delivered", result: delivered });
  failing.close();
  succeeding.close();
  provider.dispose();
}
{
  const Models = defineService("test.models");
  const provider = new RemoteServiceProvider([Models]);
  const state = replicatedState({ revision: 0, selected: null });
  provider.provide(Models, { state, async select() {} });
  let delivered = 0;
  let activationError = null;
  const subscription = provider.subscribe(Models.id, "singleton", () => {
    delivered += 1;
    throw new Error("listener failed");
  });
  state.state.revision = 1;
  state.publish(BACKGROUND_CONTEXT);
  state.state.revision = 2;
  state.publish(BACKGROUND_CONTEXT);
  try {
    subscription.activate();
  } catch (error) {
    activationError = String(error.message);
  }
  providerRows.push({ name: "buffered_replay_message", result: activationError });
  providerRows.push({ name: "buffered_replay_delivered", result: delivered });
  subscription.close();
  provider.dispose();
}
{
  const Models = defineService("test.models");
  const QuestionDialogs = defineService("test.question-dialogs");
  const provider = new RemoteServiceProvider([Models, { service: QuestionDialogs, mode: "keyed" }]);
  provider.provide(Models, {
    state: replicatedState({ revision: 0, selected: null }),
    async select() {},
  });
  providerRows.push({
    name: "spawn_on_singleton",
    ...tryRun(() => provider.spawn(Models, "wrong", { select: () => {} })),
  });
  let closeFn = null;
  providerRows.push({
    name: "spawn_keyed_ok",
    ...tryRun(() => {
      closeFn = provider.spawn(QuestionDialogs, "invocation-1", {
        request: replicatedState({ question: "First?" }),
        async submit() {
          return { accepted: true };
        },
      });
    }),
  });
  const keyedUpdates = [];
  const keyedSubscription = provider.subscribe(QuestionDialogs.id, "keyed", (update) => keyedUpdates.push(canon(update)));
  keyedSubscription.activate();
  providerRows.push({ name: "keyed_spawn_updates", result: [...keyedUpdates] });
  const invoke = await provider.invoke(
    {
      serviceId: QuestionDialogs.id,
      instance: { key: "invocation-1", generation: 1 },
      member: "submit",
      args: ["yes"],
    },
    BACKGROUND_CONTEXT,
  );
  providerRows.push({ name: "keyed_invoke_result", ...tryCanon(() => invoke) });
  providerRows.push({
    name: "keyed_invoke_stale_generation",
    ...(await tryRunAsync(() =>
      provider.invoke(
        {
          serviceId: QuestionDialogs.id,
          instance: { key: "invocation-1", generation: 2 },
          member: "submit",
          args: ["yes"],
        },
        BACKGROUND_CONTEXT,
      ),
    )),
  });
  closeFn();
  providerRows.push({ name: "keyed_closed_updates", result: [...keyedUpdates] });
  providerRows.push({
    name: "keyed_invoke_after_close",
    ...(await tryRunAsync(() =>
      provider.invoke(
        {
          serviceId: QuestionDialogs.id,
          instance: { key: "invocation-1", generation: 1 },
          member: "submit",
          args: ["yes"],
        },
        BACKGROUND_CONTEXT,
      ),
    )),
  });
  providerRows.push({
    name: "invoke_unknown_member",
    ...(await tryRunAsync(() =>
      provider.invoke({ serviceId: Models.id, member: "missing", args: [] }, BACKGROUND_CONTEXT),
    )),
  });
  providerRows.push({
    name: "invoke_unknown_service",
    ...(await tryRunAsync(() =>
      provider.invoke({ serviceId: "nope", member: "m", args: [] }, BACKGROUND_CONTEXT),
    )),
  });
  providerRows.push({
    name: "invoke_state_member",
    ...(await tryRunAsync(() =>
      provider.invoke({ serviceId: Models.id, member: "state", args: [] }, BACKGROUND_CONTEXT),
    )),
  });
  providerRows.push({
    name: "spawn_duplicate_key",
    ...tryRun(() => {
      provider.spawn(QuestionDialogs, "dupe", {
        request: replicatedState({ question: "?" }),
        async submit() {
          return { accepted: false };
        },
      });
      provider.spawn(QuestionDialogs, "dupe", {
        request: replicatedState({ question: "?" }),
        async submit() {
          return { accepted: false };
        },
      });
    }),
  });
  provider.dispose();
  providerRows.push({
    name: "invoke_after_dispose",
    ...(await tryRunAsync(() =>
      provider.invoke({ serviceId: Models.id, member: "select", args: [] }, BACKGROUND_CONTEXT),
    )),
  });
}

const out = {
  json: jsonResults,
  validation: validationRows,
  wire: wireRows,
  codec: codecRows,
  services: serviceRows,
  state: stateRows,
  provider: providerRows,
};
process.stdout.write(JSON.stringify(out));
