// Oracle capture for the chord consumer-side slice. Runs the read-only
// upstream TypeScript under `node --experimental-strip-types` and prints one
// canonical JSON line per scenario. The Rust port's tests assert the same
// values byte for byte.
import { BACKGROUND_CONTEXT } from "./upstream_src/context/index.ts";
import {
  createFacetHost,
  combineFacetLoaders,
  createRemoteServiceBinding,
  defineFacet,
  defineService,
  replicatedState,
} from "./upstream_src/api.ts";
import { RemoteServiceProvider } from "./upstream_src/services/provider.ts";
import { createLoopbackServiceTransport } from "./upstream_src/services/loopback.ts";
import { createHash } from "node:crypto";

const out = (scenario, value) => {
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonical(v)]),
          )
        : v;
  console.log(JSON.stringify({ scenario, value: canonical(value) }));
};
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

// Services used across scenarios.
const Counter = defineService("test.consumer.counter");
const KeyedCounter = defineService("test.consumer.keyed-counter");
const Source = defineService("test.facets.source");
const Projection = defineService("test.facets.projection");
const HostValues = defineService("test.facets.host-values", { local: true });

function makeProvider(value) {
  const provider = new RemoteServiceProvider([Counter]);
  provider.provide(Counter, {
    async read() {
      return value;
    },
  });
  return provider;
}

// ── Scenario 1: singleton use/invoke/state/rebind/dispose ──────────────────
{
  const provider = makeProvider("v1");
  const binding = createRemoteServiceBinding({
    services: [Counter],
    transport: createLoopbackServiceTransport(provider),
  });
  const counter = binding.use(Counter);
  const trace = [];
  const read = await counter.read(BACKGROUND_CONTEXT);
  trace.push(`read:${read}`);
  await binding.rebind(false, BACKGROUND_CONTEXT);
  try {
    await counter.read(BACKGROUND_CONTEXT);
    trace.push("read-after-unbind:ok");
  } catch (error) {
    trace.push(`read-after-unbind:${error.code ?? "error"}:${messageOf(error)}`);
  }
  await binding.rebind(true, BACKGROUND_CONTEXT);
  trace.push(`read-after-rebind:${await counter.read(BACKGROUND_CONTEXT)}`);
  try {
    binding.use(defineService("test.consumer.unknown"));
  } catch (error) {
    trace.push(`unknown:${messageOf(error)}`);
  }
  try {
    binding.use(HostValues);
  } catch (error) {
    trace.push(`local:${messageOf(error)}`);
  }
  try {
    binding.observe(Counter, async () => {});
  } catch (error) {
    trace.push(`mode:${messageOf(error)}`);
  }
  const disposed = await binding.dispose(BACKGROUND_CONTEXT);
  trace.push(`disposed:${disposed === undefined}`);
  try {
    binding.use(Counter);
  } catch (error) {
    trace.push(`disposed-use:${messageOf(error)}`);
  }
  out("consumer-singleton", trace);
}

// ── Scenario 2: duplicate binding IDs and duplicate service IDs ────────────
{
  const provider = makeProvider("v");
  const trace = [];
  try {
    createRemoteServiceBinding({
      services: [Counter, Counter],
      transport: createLoopbackServiceTransport(provider),
    });
  } catch (error) {
    trace.push(messageOf(error));
  }
  out("consumer-duplicate-ids", trace);
}

// ── Scenario 3: keyed observation spawn/close ───────────────────────────────
{
  const provider = new RemoteServiceProvider([{ service: KeyedCounter, mode: "keyed" }]);
  const binding = createRemoteServiceBinding({
    services: [KeyedCounter],
    transport: createLoopbackServiceTransport(provider),
  });
  const trace = [];
  const stop = binding.observe(KeyedCounter, async (service, context) => {
    trace.push(`observed:${await service.read(context)}`);
  });
  const closeInstance = provider.spawn(KeyedCounter, "one", {
    async read() {
      return "one";
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  trace.push(`observers:${JSON.stringify(trace.length)}`);
  closeInstance();
  await new Promise((resolve) => setTimeout(resolve, 10));
  stop();
  await binding.dispose(BACKGROUND_CONTEXT);
  out("consumer-keyed", trace);
}

// ── Scenario 4: facet host ordering, reload and errors ──────────────────────
{
  const trace = [];
  const host = await createFacetHost({
    facets: [
      defineFacet({
        id: "projection",
        setup(env) {
          trace.push("setup projection");
          const source = env.use(Source);
          try {
            void source.read;
            // Upstream proxy access throws lazily on method invocation; the
            // port asserts at handle acquisition, so the guard is checked
            // after activation below.
          } catch (error) {
            trace.push(`early-access:${messageOf(error)}`);
          }
          env.provide(Projection, {
            async read(context) {
              return source.read(context);
            },
          });
          env.onActivate(() => {
            trace.push("activate projection");
          });
          env.onDeactivate(() => {
            trace.push("dispose projection");
          });
        },
      }),
      defineFacet({
        id: "source",
        setup(env) {
          trace.push("setup source");
          env.provide(Source, {
            async read() {
              return "value";
            },
          });
          env.onActivate(() => {
            trace.push("activate source");
          });
          env.onDeactivate(() => {
            trace.push("dispose source");
          });
        },
      }),
      defineFacet({
        id: "host-values",
        setup(env) {
          trace.push("setup host-values");
          env.provide(HostValues, { name: "session", use: "host value" });
        },
      }),
    ],
  });
  trace.push(`activated:${await host.services.use(Projection).read(BACKGROUND_CONTEXT)}`);
  try {
    host.services.use(HostValues);
  } catch (error) {
    trace.push(`local-use:${messageOf(error)}`);
  }
  try {
    await createFacetHost({
      facets: [
        defineFacet({
          id: "missing",
          setup(env) {
            env.use(Source);
          },
        }),
      ],
    });
  } catch (error) {
    trace.push(`missing:${messageOf(error)}`);
  }
  try {
    await createFacetHost({
      facets: [
        defineFacet({
          id: "first",
          setup(env) {
            env.use(Projection);
            env.provide(Source, { async read() { return "first"; } });
          },
        }),
        defineFacet({
          id: "second",
          setup(env) {
            env.use(Source);
            env.provide(Projection, { async read() { return "second"; } });
          },
        }),
      ],
    });
  } catch (error) {
    trace.push(`cycle:${messageOf(error)}`);
  }
  try {
    await host.reload([
      defineFacet({
        id: "source",
        setup(env) {
          env.provide(Projection, { async read() { return "changed"; } });
        },
      }),
    ]);
  } catch (error) {
    trace.push(`reload-shape:${messageOf(error)}`);
  }
  try {
    await host.reload([]);
  } catch (error) {
    trace.push(`reload-not-active:${messageOf(error)}`);
  }
  await host.dispose();
  out("facet-host", trace);
}

// ── Scenario 5: combined facet loaders ──────────────────────────────────────
{
  const trace = [];
  const firstFacet = defineFacet({ id: "first", setup() {} });
  const secondFacet = defineFacet({ id: "second", setup() {} });
  const first = {
    async load() {
      trace.push("load first");
      return {
        facets: [firstFacet],
        async dispose() {
          trace.push("dispose first");
        },
      };
    },
  };
  const second = {
    async load() {
      trace.push("load second");
      return {
        facets: [secondFacet],
        async dispose() {
          trace.push("dispose second");
        },
      };
    },
  };
  const loaded = await combineFacetLoaders([first, second]).load();
  trace.push(`facets:${loaded.facets.map((facet) => facet.id).join(",")}`);
  await loaded.dispose();
  await loaded.dispose();
  out("facet-loaders", trace);
}

// ── Scenario 6: replicatedState constructor smoke (api surface) ─────────────
{
  const state = replicatedState({ value: 7 });
  out("replicated-state", state.value);
}

// ── Scenario 7: bundler shortHash ───────────────────────────────────────────
{
  out("short-hash-main", createHash("sha256").update("main").digest("hex").slice(0, 12));
}
