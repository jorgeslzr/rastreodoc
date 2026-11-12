export const QR_IMAGE_OPTIONS = Object.freeze({ width: 420, margin: 1, errorCorrectionLevel: "H" });
let libraryPromise;

export function preloadQrLibrary() {
  if (!libraryPromise) {
    libraryPromise = import("qrcode").then((module) => module.default).catch((error) => {
      libraryPromise = undefined;
      throw error;
    });
  }
  return libraryPromise;
}

export async function generateQrDataUrl(token) {
  if (typeof token !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(token)) {
    throw new Error("El documento no tiene un token QR válido.");
  }
  const qr = await preloadQrLibrary();
  // qrcode normalizes/mutates its options internally; give each render a copy.
  return qr.toDataURL(`RDOC:${token}`, { ...QR_IMAGE_OPTIONS });
}

// Cache only images, never document metadata. Bound memory and share in-flight
// work so previewing and printing a QR do not generate it twice.
export function createQrImageCache(generate = generateQrDataUrl, maxEntries = 64) {
  const entries = new Map();
  return {
    get(token) {
      if (entries.has(token)) {
        const existing = entries.get(token);
        entries.delete(token);
        entries.set(token, existing);
        return existing;
      }
      const pending = Promise.resolve().then(() => generate(token)).catch((error) => {
        if (entries.get(token) === pending) entries.delete(token);
        throw error;
      });
      entries.set(token, pending);
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return pending;
    },
    clear() { entries.clear(); },
  };
}

// Decode every image before printing. A failed image must produce a visible
// error instead of sending an incomplete label sheet to the printer.
export function buildQrPrintHtml({ title, labels, styles }) {
  const safeTitle = String(title).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
  return `<!doctype html><html lang="es"><head><title>${safeTitle}</title><style>${styles}.print-controls{font:14px Arial;padding:12px;text-align:center}@media print{.print-controls{display:none}}</style></head><body><div class="print-controls"><button id="print-labels" disabled>Preparando impresión…</button><p id="print-error" role="alert"></p></div>${labels.join("")}<script>
window.onload=async()=>{
  const button=document.getElementById("print-labels");
  try {
    await Promise.all(Array.from(document.images,image=>image.decode()));
  } catch {
    document.getElementById("print-error").textContent="No se pudieron cargar todos los QR. Cierra esta ventana y vuelve a preparar las etiquetas.";
    return;
  }
  button.disabled=false;
  button.textContent="Imprimir etiquetas";
  button.onclick=()=>{
    try { window.print(); }
    catch { document.getElementById("print-error").textContent="No se pudo abrir la impresión. Vuelve a pulsar Imprimir etiquetas."; }
  };
  button.click();
};
</script></body></html>`;
}
