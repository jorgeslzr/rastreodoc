// A failed refresh after a confirmed write must not look like a failed save.
export async function refreshAfterSave(load, onSuccess, onFailure, isCurrent = () => true) {
  try {
    const result = await load();
    if (!isCurrent()) return false;
    if (result.error || !Array.isArray(result.data)) {
      onFailure();
      return false;
    }
    onSuccess(result.data);
    return true;
  } catch {
    if (isCurrent()) onFailure();
    return false;
  }
}

export function scanLookupMessage(error, document) {
  if (error) return "No fue posible consultar el código QR. Revisa tu conexión y vuelve a buscar; no se registró ningún movimiento.";
  if (!document) return "No encontramos un documento activo con este código QR. Revisa el código o consulta los documentos archivados.";
  return null;
}
