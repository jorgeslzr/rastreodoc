import { useEffect, useRef, useState } from "react";
import { ActionButton } from "./ui";

export default function DocumentDeletionDialog({ document, name, busy, pending, message, onClose, onDelete, onVerify }) {
  const dialog = useRef(null);
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    const previous = window.document.activeElement;
    dialog.current?.querySelector("button")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const active = window.document.activeElement;
    if (!dialog.current?.contains(active) || active?.disabled) {
      const first = dialog.current?.querySelector("button:not(:disabled), input:not(:disabled)");
      (first ?? dialog.current)?.focus();
    }
  }, [busy, pending]);
  function onKeyDown(event) {
    if (event.key === "Escape" && !busy && !pending) { event.preventDefault(); onClose(); }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.current.querySelectorAll("button:not(:disabled), input:not(:disabled)")];
    if (!focusable.length) { event.preventDefault(); dialog.current.focus(); return; }
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-document-title" aria-describedby="delete-document-scope" onKeyDown={onKeyDown}>
    <form className="deletion-modal" ref={dialog} tabIndex={-1} onSubmit={(event) => { event.preventDefault(); if (!busy && !pending && confirmation === "ELIMINAR") onDelete(confirmation); }}>
      <button type="button" className="modal-close" aria-label="Cerrar confirmación" disabled={busy || pending} onClick={onClose}>×</button>
      <p className="eyebrow">ELIMINACIÓN DEFINITIVA</p>
      <h2 id="delete-document-title">Eliminar documento</h2>
      <dl className="deletion-summary"><div><dt>Expediente</dt><dd>{document.case_files.number}</dd></div><div><dt>Documento</dt><dd>{name}</dd></div><div><dt>Dependencia</dt><dd>{document.agencies.name}</dd></div><div><dt>Código del documento</dt><dd>{document.qr_token}</dd></div></dl>
      <p id="delete-document-scope">Se eliminarán este documento y todos sus movimientos. Su QR dejará de funcionar. El expediente y sus otros documentos se conservarán. Esta acción no se puede deshacer desde el sistema.</p>
      <label>Escribe ELIMINAR para confirmar<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={busy || pending} autoComplete="off" spellCheck={false} /></label>
      {message && <p className={`notice ${message.type}`} role="status" aria-live="polite">{message.text}</p>}
      {pending && <ActionButton type="button" icon="check" className="secondary" disabled={busy} onClick={onVerify}>{busy ? "Verificando eliminación…" : "Verificar eliminación"}</ActionButton>}
      <div className="edit-actions"><button type="button" className="secondary" disabled={busy || pending} onClick={onClose}>Cancelar</button><ActionButton type="submit" icon="trash" className="danger-button" disabled={busy || pending || confirmation !== "ELIMINAR"}>{busy ? "Procesando…" : "Eliminar definitivamente"}</ActionButton></div>
    </form>
  </div>;
}
