// Publish a complete read only after every required query succeeds. A caller
// can cancel an obsolete load; the deadline also covers a stalled SDK/fetch.
export async function loadCompleteData(loaders, { signal, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  let timer;
  let cancel;
  try {
    const interrupted = new Promise((_, reject) => {
      cancel = () => {
        controller.abort(signal.reason);
        reject(controller.signal.reason);
      };
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => {
        const error = new Error("Office data did not finish loading before its deadline.");
        error.name = "TimeoutError";
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const reads = Promise.all(loaders.map(async (load) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const result = await load(controller.signal);
      if (result?.error) throw result.error;
      if (!Array.isArray(result?.data)) throw new Error("Incomplete office data response.");
      return result.data;
    }));
    return await Promise.race([interrupted, reads]);
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export function dataLoadErrorMessage(error) {
  return error?.name === "TimeoutError"
    ? "La carga está tardando más de lo esperado. Revisa tu conexión y pulsa Reintentar carga."
    : "No se pudo cargar la información completa. Revisa tu conexión y pulsa Reintentar carga.";
}
