// Keep an uncertain write's original ID and arguments until it is verified.
// Retrying the same RPC is safe because the database stores the operation ID.
export function createDocumentOperationClient(rpc, newId = () => crypto.randomUUID()) {
  let pending = null;
  let inFlight = false;
  const rollbackCodes = new Set([
    "PT401", "PT409", "PT422", "42501", "23503", "23505", "23514",
    "22001", "22P02", "42883", "PGRST202", "PGRST301", "PGRST302",
  ]);

  async function send(verification = false) {
    inFlight = true;
    try {
      const { data, error } = await rpc(pending);
      if (error) {
        // A failed verification (e.g. an expired session) says nothing about
        // whether the ORIGINAL request committed. Preserve its identity.
        if (verification) return { kind: "uncertain" };
        if (!rollbackCodes.has(error.code)) return { kind: "uncertain" };
        pending = null;
        const kind = error.code === "PT409" ? "conflict"
          : error.code === "PT422" ? "invalid" : "unavailable";
        return { kind, error };
      }
      // An incomplete response is not proof that the transaction was rolled back.
      if (!data?.document?.id || data.document.id !== pending.p_document_id
        || !data.document.status || !data.document.last_movement_at) {
        return { kind: "uncertain" };
      }
      pending = null;
      return { kind: "saved", data };
    } catch {
      return { kind: "uncertain" };
    } finally {
      inFlight = false;
    }
  }

  return {
    isInFlight: () => inFlight,
    hasPending: () => pending !== null,
    async save(args) {
      if (inFlight) return { kind: "busy" };
      if (pending) return { kind: "pending" };
      pending = { ...args, p_operation_id: newId() };
      return send();
    },
    async retry() {
      if (inFlight) return { kind: "busy" };
      if (!pending) return { kind: "empty" };
      return send(true);
    },
  };
}

export function documentOperationArguments(document, changes) {
  return {
    p_document_id: document.id,
    p_expected_status: document.status,
    p_expected_movement_at: document.last_movement_at,
    p_expected_label: document.label ?? null,
    p_requested_status: changes.status ?? null,
    p_change_label: Boolean(changes.changeLabel),
    p_label: changes.label ?? null,
    p_receipt_number: changes.receiptNumber ?? null,
    p_rejection_reason: changes.rejectionReason ?? null,
    p_notes: changes.notes ?? null,
    p_is_correction: Boolean(changes.isCorrection),
  };
}
