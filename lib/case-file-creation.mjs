// The database's primary key and unique citext number make retries safe. Keep
// the original ID until a read confirms which case exists; never update it.
export function createCaseFileCreationClient({ insert, findById, findByNumber, newId = () => crypto.randomUUID(), timeoutMs = 20000 }) {
  let pending = null;
  let inFlight = false;
  const rollbackCodes = new Set([
    "42501", "23502", "23503", "23514", "22001", "22P02", "42703",
    "PGRST204", "PGRST301", "PGRST302",
  ]);
  const uncertain = () => ({ kind: "uncertain" });
  const validCase = (data) => typeof data?.id === "string" && data.id.length > 0
    && typeof data.number === "string" && data.number.trim().length > 0;
  const ownCase = (data, input) => validCase(data) && data.id === input.id && data.number === input.number;

  async function readOwn(input, signal) {
    if (signal.aborted) return uncertain();
    const { data, error } = await findById(input.id, signal);
    if (error) return uncertain();
    if (data === null) return null;
    return ownCase(data, input) ? { kind: "saved", data } : uncertain();
  }

  async function send(input, signal) {
    if (signal.aborted) return uncertain();
    const { data, error } = await insert({ ...input }, signal);
    if (!error) return ownCase(data, input) ? { kind: "saved", data } : uncertain();
    if (error.code !== "23505") return rollbackCodes.has(error.code) ? { kind: "failed" } : uncertain();

    const own = await readOwn(input, signal);
    if (own) return own;
    if (signal.aborted) return uncertain();
    // The adapter uses PostgreSQL citext equality. Preserve the stored spelling
    // and do not claim that an existing case was created by this request.
    const existing = await findByNumber(input.number, signal);
    if (existing.error || !validCase(existing.data)) return uncertain();
    if (existing.data.id === input.id) return ownCase(existing.data, input) ? { kind: "saved", data: existing.data } : uncertain();
    return { kind: "existing", data: existing.data };
  }

  async function run(work, verification = false) {
    inFlight = true;
    const input = pending;
    const controller = new AbortController();
    let timer;
    try {
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(uncertain()); }, timeoutMs);
      });
      // Work only returns values. A late response cannot clear a pending
      // request after this race has timed out or a new verification has begun.
      let result = await Promise.race([work(input, controller.signal), deadline]);
      if (verification && result.kind === "failed") result = uncertain();
      if (["saved", "existing", "failed"].includes(result.kind)) pending = null;
      return result;
    } catch {
      return uncertain();
    } finally {
      clearTimeout(timer);
      controller.abort();
      inFlight = false;
    }
  }

  return {
    hasPending: () => pending !== null,
    isInFlight: () => inFlight,
    async save(number) {
      if (inFlight) return { kind: "busy" };
      if (pending) return uncertain();
      if (typeof number !== "string" || !number.trim()) return { kind: "failed" };
      pending = { id: newId(), number: number.trim() };
      return run(send);
    },
    async verify() {
      if (inFlight) return { kind: "busy" };
      if (!pending) return { kind: "empty" };
      return run(async (input, signal) => await readOwn(input, signal) ?? await send(input, signal), true);
    },
  };
}
