// Keep one client-generated document ID until an uncertain insert is verified.
// A retry with that same primary key cannot create a second initial movement.
export function createDocumentCreationClient({ insert, find, newId = () => crypto.randomUUID() }) {
  let pending = null;
  let inFlight = false;
  const rollbackCodes = new Set([
    "42501", "23503", "23514", "22001", "22P02", "42703",
    "PGRST204", "PGRST301", "PGRST302",
  ]);

  function confirm(data) {
    if (data?.id !== pending.id || !data.qr_token || !data.last_movement_at
      || !data.status || !data.case_files || !data.document_types || !data.agencies) {
      return { kind: "uncertain" };
    }
    pending = null;
    return { kind: "saved", data };
  }

  async function findExisting() {
    try {
      const { data, error } = await find(pending.id);
      if (error) return { kind: "uncertain" };
      return data ? confirm(data) : null;
    } catch {
      return { kind: "uncertain" };
    }
  }

  async function send() {
    try {
      const { data, error } = await insert(pending);
      if (!error) return confirm(data);
      if (error.code === "23505") {
        // The original insert may have committed while its reply was lost.
        return await findExisting() ?? { kind: "uncertain" };
      }
      if (!rollbackCodes.has(error.code)) return { kind: "uncertain" };
      pending = null;
      return { kind: "failed", error };
    } catch {
      return { kind: "uncertain" };
    }
  }

  return {
    isInFlight: () => inFlight,
    hasPending: () => pending !== null,
    async save(input) {
      if (inFlight) return { kind: "busy" };
      if (pending) return { kind: "uncertain" };
      pending = { ...structuredClone(input), id: newId() };
      inFlight = true;
      try { return await send(); }
      finally { inFlight = false; }
    },
    async verify() {
      if (inFlight) return { kind: "busy" };
      if (!pending) return { kind: "empty" };
      inFlight = true;
      try {
        // Read first. If still absent, reuse the original ID and payload.
        return await findExisting() ?? await send();
      } finally {
        inFlight = false;
      }
    },
  };
}
