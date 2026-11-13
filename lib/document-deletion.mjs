// Keep the same identity until the server confirms the deletion. An expired
// session on a retry cannot prove that the original request was rolled back.
export function createDocumentDeletionClient(rpc, { newId = () => crypto.randomUUID(), timeoutMs = 20000 } = {}) {
  let pending = null;
  let inFlight = false;
  const rollbackCodes = new Set(["PT401", "PT409", "PT422", "42501", "23503", "22P02", "42883", "PGRST202", "PGRST301", "PGRST302"]);

  async function send(verification = false) {
    inFlight = true;
    const input = pending;
    const controller = new AbortController();
    let timer;
    try {
      const request = Promise.resolve().then(async () => {
        const { data, error } = await rpc({ ...input }, controller.signal);
        if (error) {
          if (verification || !rollbackCodes.has(error.code)) return { kind: "uncertain" };
          return { kind: error.code === "PT409" ? "conflict" : "failed", error };
        }
        return data?.deleted === true && data.document_id === input.p_document_id && data.operation_id === input.p_operation_id
          ? { kind: "deleted", data } : { kind: "uncertain" };
      });
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve({ kind: "uncertain" }); }, timeoutMs);
      });
      const result = await Promise.race([request, deadline]);
      if (["deleted", "conflict", "failed"].includes(result.kind)) pending = null;
      return result;
    } catch {
      return { kind: "uncertain" };
    } finally {
      clearTimeout(timer);
      controller.abort();
      inFlight = false;
    }
  }

  return {
    hasPending: () => pending !== null,
    isInFlight: () => inFlight,
    async remove(document, confirmation) {
      if (inFlight) return { kind: "busy" };
      if (pending) return { kind: "uncertain" };
      if (!document?.id || !document.archived_at || !document.last_movement_at || confirmation !== "ELIMINAR") return { kind: "failed" };
      pending = {
        p_operation_id: newId(), p_document_id: document.id,
        p_expected_archived_at: document.archived_at,
        p_expected_movement_at: document.last_movement_at,
        p_expected_label: document.label ?? null, p_confirmation: confirmation,
      };
      return send();
    },
    async verify() {
      if (inFlight) return { kind: "busy" };
      return pending ? send(true) : { kind: "empty" };
    },
  };
}
