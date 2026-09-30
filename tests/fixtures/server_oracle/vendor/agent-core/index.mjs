// Minimal offline stand-in for the `@earendil-works/pi-agent-core` runtime
// surface used by the copied upstream `packages/server` sources: the
// BACKGROUND_CONTEXT / TODO_CONTEXT constants, `withAbortSignal`, and
// `MemorySessionRepo` (only the create/open/list/facade-close subset the
// testing host exercises). The Context/Session/SessionMetadata *types* are
// compile-time only (erased by --experimental-strip-types). Only used to run
// the upstream server sources for oracle capture.
const BACKGROUND_CONTEXT = Object.freeze({});
const TODO_CONTEXT = Object.freeze({});

function withAbortSignal(signal, context) {
  return Object.freeze({ ...context, abortSignal: signal });
}

class MemorySessionRepo {
  #now;
  #sessions = new Map();
  constructor(options = {}) {
    this.#now = options.now ?? (() => Date.now());
  }
  async create({ id, parentSessionId } = {}, _context) {
    const metadata = {
      id,
      createdAt: this.#now(),
      storageVersion: 1,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
    };
    const session = {
      metadata,
      closed: false,
      async close() {
        session.closed = true;
      },
    };
    this.#sessions.set(id, session);
    return session;
  }
  async open(metadata, _context) {
    const session = this.#sessions.get(metadata.id);
    if (!session) throw new Error(`Unknown session: ${metadata.id}`);
    if (session.closed) {
      session.closed = false;
    }
    return session;
  }
  async list(_query, _context) {
    return [...this.#sessions.values()].map((session) => session.metadata);
  }
  async delete(metadata, _context) {
    this.#sessions.delete(metadata.id);
  }
}

export { BACKGROUND_CONTEXT, TODO_CONTEXT, withAbortSignal, MemorySessionRepo };
