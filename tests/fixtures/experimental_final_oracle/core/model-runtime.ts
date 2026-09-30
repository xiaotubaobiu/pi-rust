// Oracle stub for upstream `core/model-runtime.ts` so the verbatim
// `experimental/radius-auth.ts` resolver runs. The stub honors the
// ORACLE_STORED_TOKEN knob and counts `create` calls (the port asserts the
// `??=` single-creation behavior).
export class ModelRuntime {
  static createCount = 0;
  static async create() {
    ModelRuntime.createCount += 1;
    return new ModelRuntime();
  }
  async getAuth() {
    if (process.env.ORACLE_STORED_TOKEN === undefined) return undefined;
    return { auth: { headers: { authorization: `Bearer ${process.env.ORACLE_STORED_TOKEN}` } } };
  }
}
