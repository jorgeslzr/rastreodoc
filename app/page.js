"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();
const DEFAULT_DOCUMENT_TYPES = [
  "CERTIFICADO", "AVISO PREVENTIVO", "ESCRITURA", "ACTA", "ISAI",
  "INFORME TEST. REGISTRO", "INFORME TEST. ARCHIVO", "OTROS",
];
const DEFAULT_AGENCIES = [
  "REGISTRO PÚBLICO", "TESORERÍA MUNICIPAL", "ARCHIVO GENERAL DE NOTARÍAS",
];
const USER_DOMAIN = "usuarios.rastreadoc.mx";
const ROLE_LABELS = {
  admin: "Administrador",
  supervisor: "Supervisor",
  empleado: "Empleado",
  consulta: "Consulta",
};

const DOCUMENT_AGENCY_MAP = {
  PREVENTIVO: "REGISTRO PÚBLICO",
  PREVEVENTIVO: "REGISTRO PÚBLICO",
  CERTIFICADO: "REGISTRO PÚBLICO",
  ESCRITURA: "REGISTRO PÚBLICO",
  ACTA: "REGISTRO PÚBLICO",
  "INFORME TEST. REGISTRO": "REGISTRO PÚBLICO",
  "AVISO PREVENTIVO": "REGISTRO PÚBLICO",
  ISAI: "TESORERÍA MUNICIPAL",
  "INFORME TEST. ARCHIVO": "ARCHIVO GENERAL DE NOTARÍAS",
};

function usernameToEmail(username) {
  const cleanUsername = username.trim().toLocaleLowerCase("es-MX").replace(/\s+/g, "_");
  return cleanUsername.includes("@") ? cleanUsername : `${cleanUsername}@${USER_DOMAIN}`;
}

function formatDocumentName(document) {
  const label = document.label?.trim();
  return label ? `${document.document_types.name} — ${label}` : document.document_types.name;
}

function formatStatus(status) {
  if (status === "EN_OFICINA") return "LISTO PARA ENVIAR";
  if (status === "REENVIADO") return "REINGRESADO";
  return status.replaceAll("_", " ");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function formatTimeOutside(date, currentTime) {
  const totalHours = Math.max(0, Math.floor((currentTime - new Date(date).getTime()) / 3600000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days === 0) return `${hours} ${hours === 1 ? "hora" : "horas"}`;
  return `${days} ${days === 1 ? "día" : "días"}, ${hours} ${hours === 1 ? "hora" : "horas"}`;
}

function isOutsideOffice(status) {
  return ["ENVIADO", "REENVIADO"].includes(status);
}

function buildQrPayload(token) {
  return `RDOC:${token}`;
}

function normalizeScannedToken(value) {
  const cleanValue = value.trim();
  const lastSegment = cleanValue.split(/[/?#]/).filter(Boolean).at(-1) ?? cleanValue;
  return lastSegment.replace(/^RDOC:/i, "").trim();
}

export default function HomePage() {
  const [session, setSession] = useState(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [number, setNumber] = useState("");
  const [caseFiles, setCaseFiles] = useState([]);
  const [caseSearch, setCaseSearch] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [documentLabel, setDocumentLabel] = useState("");
  const [agency, setAgency] = useState("");
  const [documentTypes, setDocumentTypes] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [newDocumentTypeName, setNewDocumentTypeName] = useState("");
  const [newAgencyName, setNewAgencyName] = useState("");
  const [documents, setDocuments] = useState([]);
  const [archivedDocuments, setArchivedDocuments] = useState([]);
  const [qrPreview, setQrPreview] = useState(null);
  const [selectedQrIds, setSelectedQrIds] = useState([]);
  const [scanToken, setScanToken] = useState("");
  const [scannedDocument, setScannedDocument] = useState(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [movementNotes, setMovementNotes] = useState("");
  const [receiptNumber, setReceiptNumber] = useState("");
  const [manualMovementReady, setManualMovementReady] = useState(false);
  const [editPreview, setEditPreview] = useState(null);
  const [correctedStatus, setCorrectedStatus] = useState("");
  const [correctionNote, setCorrectionNote] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [historyPreview, setHistoryPreview] = useState(null);
  const [scanMode, setScanMode] = useState("");
  const [activeView, setActiveView] = useState("panel");
  const [receiptCaseSearch, setReceiptCaseSearch] = useState("");
  const [receiptDrafts, setReceiptDrafts] = useState({});
  const [reportMovements, setReportMovements] = useState([]);
  const [reportStatus, setReportStatus] = useState("");
  const [reportType, setReportType] = useState("");
  const [reportStart, setReportStart] = useState("");
  const [reportEnd, setReportEnd] = useState("");
  const [reportCase, setReportCase] = useState("");
  const [casePreview, setCasePreview] = useState(null);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const scanInputRef = useRef(null);
  const [message, setMessage] = useState(null);
  const [currentRole, setCurrentRole] = useState("admin");
  const [currentUsername, setCurrentUsername] = useState("");
  const [profiles, setProfiles] = useState([]);
  const [newUsername, setNewUsername] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState("consulta");
  const [passwordDrafts, setPasswordDrafts] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoadingSession(false);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!session) return;

    Promise.all([
      supabase.from("case_files").select("id, number").order("created_at", { ascending: false }),
      supabase.from("document_types").select("id, name").order("name"),
      supabase.from("agencies").select("id, name").order("name"),
      supabase.from("profiles").select("id, username, role").order("created_at", { ascending: false }),
      supabase.from("documents").select("id, qr_token, label, status, last_movement_at, archived_at, case_files(number), document_types(name), agencies(name)").is("archived_at", null).order("created_at", { ascending: false }),
      supabase.from("documents").select("id, qr_token, label, status, last_movement_at, archived_at, case_files(number), document_types(name), agencies(name)").not("archived_at", "is", null).order("archived_at", { ascending: false }),
      supabase.from("movements").select("id, status, occurred_at, receipt_number, documents(id, label, case_files(number), document_types(name), agencies(name))").order("occurred_at", { ascending: false }),
    ]).then(([caseResult, typeResult, agencyResult, profileResult, documentResult, archivedResult, movementResult]) => {
      setCaseFiles(caseResult.data ?? []);
      setDocumentTypes(typeResult.data ?? []);
      setAgencies(agencyResult.data ?? []);
      setProfiles(profileResult.data ?? []);
      const sessionProfile = profileResult.data?.find((profile) => profile.id === session.user.id);
      setCurrentRole(sessionProfile?.role ?? "admin");
      setCurrentUsername(sessionProfile?.username ?? session.user.email?.split("@")[0] ?? "usuario");
      setDocuments(documentResult.data ?? []);
      setArchivedDocuments(archivedResult.data ?? []);
      setReportMovements(movementResult.data ?? []);
    });
  }, [session]);

  async function signIn(event) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    const { error } = await supabase.auth.signInWithPassword({ email: usernameToEmail(email), password });
    setBusy(false);

    if (error) {
      setMessage({ type: "error", text: "Correo o contraseña incorrectos." });
    }
  }

  async function createSystemUser(event) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const { data: sessionData } = await supabase.auth.getSession();
    const response = await fetch("/api/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionData.session?.access_token ?? ""}`,
      },
      body: JSON.stringify({ username: newUsername, password: newUserPassword, role: newUserRole }),
    });
    const result = await response.json();
    setBusy(false);

    if (!response.ok) {
      setMessage({ type: "error", text: result.error ?? "No fue posible crear el usuario." });
      return;
    }

    setProfiles((current) => [result.user, ...current.filter((profile) => profile.id !== result.user.id)]);
    setNewUsername("");
    setNewUserPassword("");
    setNewUserRole("consulta");
    setMessage({ type: "success", text: `Usuario ${result.user.username} creado correctamente.` });
  }

  async function changeUserPassword(profile) {
    const password = passwordDrafts[profile.id] ?? "";
    if (password.length < 6) {
      setMessage({ type: "error", text: "La nueva contraseña debe tener al menos 6 caracteres." });
      return;
    }

    const confirmed = window.confirm(`Cambiar contraseña de ${profile.username}. ¿Confirmas?`);
    if (!confirmed) return;

    setBusy(true);
    setMessage(null);
    const { data: sessionData } = await supabase.auth.getSession();
    const response = await fetch("/api/users", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionData.session?.access_token ?? ""}`,
      },
      body: JSON.stringify({ userId: profile.id, password }),
    });
    const result = await response.json();
    setBusy(false);

    if (!response.ok) {
      setMessage({ type: "error", text: result.error ?? "No fue posible cambiar la contraseña." });
      return;
    }

    setPasswordDrafts((current) => ({ ...current, [profile.id]: "" }));
    setMessage({ type: "success", text: `Contraseña de ${profile.username} actualizada correctamente.` });
  }

  async function deleteSystemUser(profile) {
    const confirmed = window.confirm(`Eliminar usuario ${profile.username}. Esta acción no elimina movimientos históricos. ¿Confirmas?`);
    if (!confirmed) return;

    setBusy(true);
    setMessage(null);
    const { data: sessionData } = await supabase.auth.getSession();
    const response = await fetch("/api/users", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionData.session?.access_token ?? ""}`,
      },
      body: JSON.stringify({ userId: profile.id }),
    });
    const result = await response.json();
    setBusy(false);

    if (!response.ok) {
      setMessage({ type: "error", text: result.error ?? "No fue posible eliminar el usuario." });
      return;
    }

    setProfiles((current) => current.filter((item) => item.id !== profile.id));
    setMessage({ type: "success", text: `Usuario ${profile.username} eliminado correctamente.` });
  }

  async function createCaseFile(event) {
    event.preventDefault();
    const cleanNumber = number.trim();

    if (!cleanNumber) return;

    setBusy(true);
    setMessage(null);
    const { data, error } = await supabase
      .from("case_files")
      .insert({ number: cleanNumber })
      .select("id, number")
      .single();
    setBusy(false);

    if (error?.code === "23505") {
      setMessage({
        type: "error",
        text: "Este número de expediente ya existe. No se guardó un duplicado.",
      });
      return;
    }

    if (error) {
      setMessage({ type: "error", text: "No fue posible guardar el expediente." });
      return;
    }

    setNumber("");
    setCaseFiles((current) => [data, ...current]);
    setCaseSearch(data.number);
    setMessage({ type: "success", text: `Expediente ${cleanNumber} guardado correctamente.` });
  }

  async function findOrCreate(table, name) {
    const cleanName = name.trim();
    const existing = await supabase.from(table).select("id, name").eq("name", cleanName).maybeSingle();
    if (existing.data) return existing.data;

    const created = await supabase.from(table).insert({ name: cleanName }).select("id, name").single();
    if (created.data) return created.data;

    const repeated = await supabase.from(table).select("id, name").eq("name", cleanName).single();
    return repeated.data;
  }

  function changeDocumentType(nextType) {
    setDocumentType(nextType);
    const mappedAgency = DOCUMENT_AGENCY_MAP[nextType.toLocaleUpperCase("es-MX")];
    if (mappedAgency) setAgency(mappedAgency);
    if (!nextType || nextType === "OTROS") setAgency("");
  }

  async function addCatalogItem(event, table, value, setter, collectionSetter, successLabel) {
    event.preventDefault();
    const cleanName = value.trim().toLocaleUpperCase("es-MX");
    if (!cleanName) return;

    setBusy(true);
    setMessage(null);
    const record = await findOrCreate(table, cleanName);
    setBusy(false);

    if (!record) {
      setMessage({ type: "error", text: `No fue posible guardar ${successLabel}.` });
      return;
    }

    collectionSetter((current) => current.some(({ id, name }) => id === record.id || name.toLocaleUpperCase("es-MX") === cleanName) ? current : [...current, record].sort((a, b) => a.name.localeCompare(b.name, "es")));
    setter("");
    setMessage({ type: "success", text: `${successLabel} guardado correctamente.` });
  }

  async function createDocument(event) {
    event.preventDefault();
    const selectedCase = caseFiles.find((caseFile) => caseFile.number.toLocaleLowerCase("es-MX") === caseSearch.trim().toLocaleLowerCase("es-MX"));
    if (!selectedCase) {
      setMessage({ type: "error", text: "Selecciona un expediente existente de la búsqueda." });
      return;
    }
    if (!documentType.trim() || !agency.trim()) return;

    setBusy(true);
    setMessage(null);
    const [typeRecord, agencyRecord] = await Promise.all([
      findOrCreate("document_types", documentType),
      findOrCreate("agencies", agency),
    ]);

    if (!typeRecord || !agencyRecord) {
      setBusy(false);
      setMessage({ type: "error", text: "No fue posible preparar el tipo o la dependencia." });
      return;
    }

    const { data, error } = await supabase.from("documents").insert({
      case_file_id: selectedCase.id,
      document_type_id: typeRecord.id,
      agency_id: agencyRecord.id,
      label: documentLabel.trim() || null,
      status: "EN_OFICINA",
    }).select("id, qr_token, label, status, last_movement_at, archived_at, case_files(number), document_types(name), agencies(name)").single();
    setBusy(false);

    if (error) {
      setMessage({ type: "error", text: "No fue posible guardar el documento." });
      return;
    }

    setDocumentTypes((current) => current.some(({ id }) => id === typeRecord.id) ? current : [...current, typeRecord]);
    setAgencies((current) => current.some(({ id }) => id === agencyRecord.id) ? current : [...current, agencyRecord]);
    setDocuments((current) => [data, ...current]);
    setDocumentType("");
    setDocumentLabel("");
    setAgency("");
    setMessage({ type: "success", text: "Documento agregado con estatus LISTO PARA ENVIAR." });
    const { data: refreshedMovements } = await supabase.from("movements").select("id, status, occurred_at, receipt_number, documents(id, label, case_files(number), document_types(name), agencies(name))").order("occurred_at", { ascending: false });
    setReportMovements(refreshedMovements ?? []);
  }

  async function showQr(document) {
    const QRCode = (await import("qrcode")).default;
    const dataUrl = await QRCode.toDataURL(buildQrPayload(document.qr_token), { width: 420, margin: 1, errorCorrectionLevel: "H" });
    setQrPreview({ document, dataUrl });
  }

  function buildLabelHtml(document, dataUrl) {
    return `<section class="label"><img class="qr" src="${dataUrl}"><div class="info"><div class="brand">RASTREADOC</div><div class="case">${escapeHtml(document.case_files.number)}</div><div class="text">${escapeHtml(formatDocumentName(document))}</div><div class="text agency">${escapeHtml(document.agencies.name)}</div><div class="hint">Escanear para movimiento</div></div></section>`;
  }

  function labelPrintStyles() {
    return `@page{size:40mm 30mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0}body{font-family:Arial,sans-serif;color:#111}.label{width:40mm;height:30mm;display:grid;grid-template-columns:20mm 1fr;gap:1.2mm;align-items:center;padding:1.5mm;overflow:hidden;break-after:page;page-break-after:always}.label:last-child{break-after:auto;page-break-after:auto}.qr{width:20mm;height:20mm}.info{min-width:0}.brand{font-size:5pt;font-weight:800;letter-spacing:.04em}.case{font-size:8pt;font-weight:800;line-height:1.05;margin:.6mm 0}.text{font-size:5pt;line-height:1.05;margin:.5mm 0;word-break:break-word}.agency{font-size:4.6pt}.hint{font-size:4pt;margin-top:.7mm}@media screen{body{display:grid;place-items:center;gap:8px;min-height:100vh;background:#eee}.label{background:white;border:1px solid #ddd;transform:scale(2.5);transform-origin:center;margin:26mm}}@media print{button{display:none}}`;
  }

  function printQr() {
    const popup = window.open("", "_blank", "width=520,height=680");
    if (!popup || !qrPreview) return;

    const { document, dataUrl } = qrPreview;
    popup.document.write(`<!doctype html><html><head><title>QR ${escapeHtml(document.case_files.number)}</title><style>${labelPrintStyles()}</style></head><body>${buildLabelHtml(document, dataUrl)}<script>window.onload=()=>window.print()</script></body></html>`);
    popup.document.close();
  }

  async function printSelectedQrLabels() {
    const selectedDocuments = documents.filter((document) => selectedQrIds.includes(document.id) && document.status === "EN_OFICINA");
    if (selectedDocuments.length === 0) {
      setMessage({ type: "error", text: "Selecciona al menos un documento listo para enviar." });
      return;
    }

    const QRCode = (await import("qrcode")).default;
    const labels = await Promise.all(selectedDocuments.map(async (document) => {
      const dataUrl = await QRCode.toDataURL(buildQrPayload(document.qr_token), { width: 420, margin: 1, errorCorrectionLevel: "H" });
      return buildLabelHtml(document, dataUrl);
    }));

    const popup = window.open("", "_blank", "width=900,height=700");
    if (!popup) return;
    popup.document.write(`<!doctype html><html><head><title>Etiquetas RASTREADOC</title><style>${labelPrintStyles()}</style></head><body>${labels.join("")}<script>window.onload=()=>window.print()</script></body></html>`);
    popup.document.close();
  }

  function toggleQrSelection(documentId) {
    setSelectedQrIds((current) => current.includes(documentId) ? current.filter((id) => id !== documentId) : [...current, documentId]);
  }

  async function scanDocument(event) {
    event.preventDefault();
    const token = normalizeScannedToken(scanToken);
    if (!token) return;

    setBusy(true);
    setMessage(null);
    const { data, error } = await supabase
      .from("documents")
      .select("id, qr_token, label, status, last_movement_at, case_files(number), document_types(name), agencies(name)")
      .eq("qr_token", token)
      .maybeSingle();
    setBusy(false);

    if (error || !data) {
      setScannedDocument(null);
      setMessage({ type: "error", text: "No encontramos un documento con este código QR." });
      return;
    }

    setScannedDocument(data);
    setManualMovementReady(false);
    setScanToken("");
    if (scanMode) {
      await registerMovement(scanMode, data);
    }
    scanInputRef.current?.focus();
  }

  function confirmSensitiveMovement(status, document) {
    if (!document || !["AUTORIZADO", "RECHAZADO"].includes(status)) return true;
    return window.confirm(`Vas a marcar ${formatDocumentName(document)} del expediente ${document.case_files.number} como ${formatStatus(status)}. ¿Confirmas que es correcto?`);
  }

  function activateScanMode(status) {
    if (scanMode === status) {
      setScanMode("");
      setManualMovementReady(false);
      scanInputRef.current?.focus();
      return;
    }

    if (["AUTORIZADO", "RECHAZADO"].includes(status)) {
      const confirmed = window.confirm(`Activar modo ${formatStatus(status)}. Cada QR escaneado se guardará automáticamente con ese estatus. ¿Confirmas?`);
      if (!confirmed) return;
    }

    setScanMode(status);
    setManualMovementReady(false);
    scanInputRef.current?.focus();
  }

  async function registerMovement(status, targetDocument = scannedDocument) {
    if (!targetDocument) return;
    if (!scanMode && !confirmSensitiveMovement(status, targetDocument)) return;
    setBusy(true);
    setMessage(null);

    if (status === "ENVIADO" && !receiptNumber.trim()) {
      setBusy(false);
      setMessage({ type: "error", text: "Escribe el número de boleta antes de registrar el envío." });
      return;
    }

    let resolvedStatus = status;
    if (status === "ENVIADO") {
      const { data: previousSends, error: historyError } = await supabase
        .from("movements")
        .select("id")
        .eq("document_id", targetDocument.id)
        .in("status", ["ENVIADO", "REENVIADO"])
        .limit(1);

      if (historyError) {
        setBusy(false);
        setMessage({ type: "error", text: "No fue posible comprobar los envíos anteriores." });
        return;
      }

      if (previousSends.length > 0) resolvedStatus = "REENVIADO";
    }

    const { error } = await supabase.from("movements").insert({
      document_id: targetDocument.id,
      status: resolvedStatus,
      rejection_reason: resolvedStatus === "RECHAZADO" ? rejectionReason.trim() || null : null,
      notes: movementNotes.trim() || null,
      receipt_number: ["ENVIADO", "REENVIADO"].includes(resolvedStatus) ? receiptNumber.trim() : null,
      created_by: session.user.id,
    });
    setBusy(false);

    if (error) {
      setMessage({ type: "error", text: "No fue posible registrar el movimiento." });
      return;
    }

    const updated = { ...targetDocument, status: resolvedStatus, last_movement_at: new Date().toISOString() };
    setScannedDocument(updated);
    setDocuments((current) => current.map((document) => document.id === updated.id ? { ...document, status } : document));
    if (!scanMode) {
      setRejectionReason("");
      setMovementNotes("");
    }
    if (["ENVIADO", "REENVIADO"].includes(resolvedStatus)) setReceiptNumber("");
    setMessage({ type: "success", text: `Movimiento registrado: ${formatStatus(resolvedStatus)}.` });
    setManualMovementReady(false);
    const { data: refreshedMovements } = await supabase.from("movements").select("id, status, occurred_at, receipt_number, documents(id, label, case_files(number), document_types(name), agencies(name))").order("occurred_at", { ascending: false });
    setReportMovements(refreshedMovements ?? []);
  }

  async function registerReceiptSend(document) {
    const cleanReceipt = (receiptDrafts[document.id] ?? "").trim();
    if (!cleanReceipt) {
      setMessage({ type: "error", text: "Escribe el número de boleta antes de marcar el documento como enviado." });
      return;
    }

    setBusy(true);
    setMessage(null);
    const { data: previousSends, error: historyError } = await supabase
      .from("movements")
      .select("id")
      .eq("document_id", document.id)
      .in("status", ["ENVIADO", "REENVIADO"])
      .limit(1);

    if (historyError) {
      setBusy(false);
      setMessage({ type: "error", text: "No fue posible comprobar si el documento ya había sido enviado." });
      return;
    }

    const resolvedStatus = previousSends.length > 0 ? "REENVIADO" : "ENVIADO";
    const { error } = await supabase.from("movements").insert({
      document_id: document.id,
      status: resolvedStatus,
      receipt_number: cleanReceipt,
      notes: "Captura de boleta sin escaneo QR",
      created_by: session.user.id,
    });
    setBusy(false);

    if (error) {
      setMessage({ type: "error", text: "No fue posible guardar la boleta." });
      return;
    }

    setDocuments((current) => current.map((item) => item.id === document.id ? { ...item, status: resolvedStatus, last_movement_at: new Date().toISOString() } : item));
    setReceiptDrafts((current) => ({ ...current, [document.id]: "" }));
    setMessage({ type: "success", text: `Boleta guardada. Documento marcado como ${formatStatus(resolvedStatus)}.` });
    const { data: refreshedMovements } = await supabase.from("movements").select("id, status, occurred_at, receipt_number, documents(id, label, case_files(number), document_types(name), agencies(name))").order("occurred_at", { ascending: false });
    setReportMovements(refreshedMovements ?? []);
  }

  async function showHistory(document) {
    setBusy(true);
    const { data, error } = await supabase
      .from("movements")
      .select("id, status, occurred_at, receipt_number, rejection_reason, notes")
      .eq("document_id", document.id)
      .order("occurred_at", { ascending: false });
    setBusy(false);

    if (error) {
      setMessage({ type: "error", text: "No fue posible consultar el historial." });
      return;
    }

    setHistoryPreview({ document, movements: data });
  }

  function prepareSend(document) {
    setScannedDocument(document);
    setScanMode("ENVIADO");
    setReceiptNumber("");
    setMovementNotes("");
    setManualMovementReady(true);
    setActiveView("escanear");
    setMessage(null);
  }

  function prepareCorrection(document) {
    setEditPreview(document);
    setCorrectedStatus(document.status);
    setCorrectionNote("");
  }

  async function saveStatusCorrection(event) {
    event.preventDefault();
    if (!editPreview || !correctedStatus) return;
    const confirmed = window.confirm(`Estatus actual: ${formatStatus(editPreview.status)}. Nuevo estatus: ${formatStatus(correctedStatus)}. ¿Guardar esta corrección?`);
    if (!confirmed) return;
    setBusy(true);
    setMessage(null);

    const note = correctionNote.trim()
      ? `CORRECCIÓN DE CAPTURA: ${correctionNote.trim()}`
      : "CORRECCIÓN DE CAPTURA";
    const { error } = await supabase.from("movements").insert({
      document_id: editPreview.id,
      status: correctedStatus,
      notes: note,
      created_by: session.user.id,
    });
    setBusy(false);

    if (error) {
      setMessage({ type: "error", text: "No fue posible corregir el estatus." });
      return;
    }

    setDocuments((current) => current.map((document) => document.id === editPreview.id ? { ...document, status: correctedStatus } : document));
    const { data: refreshedMovements } = await supabase.from("movements").select("id, status, occurred_at, receipt_number, documents(id, label, case_files(number), document_types(name), agencies(name))").order("occurred_at", { ascending: false });
    setReportMovements(refreshedMovements ?? []);
    setEditPreview(null);
    setMessage({ type: "success", text: `Estatus corregido a ${formatStatus(correctedStatus)}. El movimiento anterior se conservó en el historial.` });
  }

  async function archiveDocument(document) {
    const confirmed = window.confirm(`Vas a archivar ${formatDocumentName(document)} del expediente ${document.case_files.number}. No se borrará el historial, solo se ocultará de la operación diaria. ¿Confirmas?`);
    if (!confirmed) return;
    setBusy(true);
    setMessage(null);
    const archivedAt = new Date().toISOString();
    const { error } = await supabase.from("documents").update({ archived_at: archivedAt }).eq("id", document.id);
    setBusy(false);

    if (error) {
      setMessage({ type: "error", text: "No fue posible archivar el documento." });
      return;
    }

    setDocuments((current) => current.filter((item) => item.id !== document.id));
    setArchivedDocuments((current) => [{ ...document, archived_at: archivedAt }, ...current]);
    if (scannedDocument?.id === document.id) setScannedDocument(null);
    setMessage({ type: "success", text: "Documento archivado. Su historial se conservó." });
  }

  async function restoreDocument(document) {
    setBusy(true);
    setMessage(null);
    const { error } = await supabase.from("documents").update({ archived_at: null }).eq("id", document.id);
    setBusy(false);

    if (error) {
      setMessage({ type: "error", text: "No fue posible restaurar el documento." });
      return;
    }

    setArchivedDocuments((current) => current.filter((item) => item.id !== document.id));
    setDocuments((current) => [{ ...document, archived_at: null }, ...current]);
    setMessage({ type: "success", text: "Documento restaurado y disponible nuevamente." });
  }

  function exportReportToExcel() {
    const headers = ["Fecha", "Expediente", "Documento", "Dependencia", "Movimiento", "Boleta"];
    const safeCsvCell = (value) => {
      let text = String(value ?? "");
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = filteredReportMovements.map((movement) => [
      new Date(movement.occurred_at).toLocaleString("es-MX"),
      movement.documents?.case_files?.number,
      movement.documents ? formatDocumentName(movement.documents) : "",
      movement.documents?.agencies?.name,
      formatStatus(movement.status),
      movement.receipt_number || "",
    ]);
    const csv = [headers, ...rows].map((row) => row.map(safeCsvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `reporte-rastreadoc-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function openPrintableReport(autoPrint) {
    const popup = window.open("", "_blank", "width=1100,height=750");
    if (!popup) return;
    const rows = filteredReportMovements.map((movement) => `<tr><td>${escapeHtml(new Date(movement.occurred_at).toLocaleString("es-MX"))}</td><td>${escapeHtml(movement.documents?.case_files?.number)}</td><td>${escapeHtml(movement.documents ? formatDocumentName(movement.documents) : "")}</td><td>${escapeHtml(movement.documents?.agencies?.name)}</td><td>${escapeHtml(formatStatus(movement.status))}</td><td>${escapeHtml(movement.receipt_number || "—")}</td></tr>`).join("");
    const filters = [reportCase && `Expediente: ${reportCase}`, reportStart && `Desde: ${reportStart}`, reportEnd && `Hasta: ${reportEnd}`, reportStatus && `Estatus: ${formatStatus(reportStatus)}`, reportType && `Tipo: ${reportType}`].filter(Boolean).join(" · ") || "Todos los movimientos";
    popup.document.write(`<!doctype html><html lang="es"><head><title>Reporte RASTREADOC</title><style>body{font-family:Arial;margin:32px;color:#17232d}header{border-bottom:3px solid #18324a;margin-bottom:24px;padding-bottom:14px}h1{margin:0;color:#18324a}p{color:#667580}.toolbar{margin-bottom:20px}.toolbar button{padding:10px 18px;border:0;border-radius:6px;background:#246b8e;color:white;font-weight:bold}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:9px;border-bottom:1px solid #dce3e8;text-align:left}th{background:#f4f6f7}@media print{.toolbar{display:none}body{margin:12mm}}</style></head><body><div class="toolbar"><button onclick="window.print()">Guardar como PDF / Imprimir</button></div><header><h1>RASTREADOC</h1><p>Reporte de movimientos — ${escapeHtml(filters)}</p><strong>${filteredReportMovements.length} movimientos</strong></header><table><thead><tr><th>Fecha</th><th>Expediente</th><th>Documento</th><th>Dependencia</th><th>Movimiento</th><th>Boleta</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No hay movimientos para mostrar.</td></tr>'}</tbody></table>${autoPrint ? '<script>window.onload=()=>window.print()</script>' : ""}</body></html>`);
    popup.document.close();
  }

  if (loadingSession) {
    return <main className="center-shell">Cargando RASTREADOC…</main>;
  }

  if (!session) {
    return (
      <main className="login-shell">
        <section className="login-copy">
          <p className="eyebrow">SISTEMA NOTARIAL</p>
          <h1>Todo documento,<br />siempre localizado.</h1>
          <p className="intro">Controla expedientes, documentos y movimientos desde un solo lugar.</p>
        </section>
        <form className="panel login-panel" onSubmit={signIn}>
          <h2>Iniciar sesión</h2>
          <p>Utiliza el usuario que creaste en Supabase.</p>
          <label>Usuario o correo<input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Ejemplo: supervisor" required /></label>
          <label>Contraseña<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          {message && <div className={`notice ${message.type}`}>{message.text}</div>}
          <button type="submit" disabled={busy}>{busy ? "Ingresando…" : "Ingresar"}</button>
        </form>
      </main>
    );
  }

  const normalizedSearch = search.trim().toLocaleLowerCase("es-MX");
  const filteredDocuments = documents.filter((document) => {
    const matchesText = !normalizedSearch || [
      document.case_files.number,
      formatDocumentName(document),
      document.agencies.name,
    ].some((value) => value.toLocaleLowerCase("es-MX").includes(normalizedSearch));
    return matchesText && (!statusFilter || document.status === statusFilter);
  });
  const statusCards = [
    ["EN_OFICINA", "Listos para enviar"], ["ENVIADO", "Enviados"],
    ["RECHAZADO", "Rechazados"], ["AUTORIZADO", "Autorizados"],
    ["REENVIADO", "Reingresados"],
  ];
  const canManageAll = ["admin", "supervisor"].includes(currentRole);
  const canOperate = canManageAll || currentRole === "empleado";
  const canManageUsers = canManageAll;
  const availableDocumentTypes = [...new Set([...DEFAULT_DOCUMENT_TYPES, ...documentTypes.map(({ name }) => name).filter((name) => !["PREPRE", "REGISTRO"].includes(name.toLocaleUpperCase("es-MX")))])].sort((a, b) => a.localeCompare(b, "es"));
  const availableAgencies = [...new Set([...DEFAULT_AGENCIES, ...agencies.map(({ name }) => name)])].sort((a, b) => a.localeCompare(b, "es"));
  const filteredReportMovements = reportMovements.filter((movement) => {
    const movementDate = movement.occurred_at.slice(0, 10);
    const caseNumber = movement.documents?.case_files?.number ?? "";
    return (!reportStart || movementDate >= reportStart)
      && (!reportEnd || movementDate <= reportEnd)
      && (!reportStatus || movement.status === reportStatus)
      && (!reportType || movement.documents?.document_types?.name === reportType)
      && (!reportCase.trim() || caseNumber.toLocaleLowerCase("es-MX").includes(reportCase.trim().toLocaleLowerCase("es-MX")));
  });
  const casePreviewDocuments = casePreview
    ? documents.filter((document) => document.case_files.number === casePreview)
    : [];
  const caseStatusSummary = statusCards
    .map(([status, label]) => [status, label, casePreviewDocuments.filter((document) => document.status === status).length])
    .filter(([, , count]) => count > 0);
  const normalizedReceiptCaseSearch = receiptCaseSearch.trim().toLocaleLowerCase("es-MX");
  const receiptDocuments = documents.filter((document) => document.status === "EN_OFICINA" && (!normalizedReceiptCaseSearch || document.case_files.number.toLocaleLowerCase("es-MX").includes(normalizedReceiptCaseSearch)));
  const latestReceiptFor = (documentId) => reportMovements.find((movement) => movement.documents?.id === documentId && movement.receipt_number)?.receipt_number;
  const viewTitles = {
    panel: ["RESUMEN", "Panel principal"],
    alta: ["CAPTURA", "Nuevo expediente"],
    escanear: ["OPERACIÓN RÁPIDA", "Escanear documentos"],
    boletas: ["ENVÍO", "Capturar boletas"],
    consulta: ["CONSULTA", "Buscar documentos"],
    reportes: ["ANÁLISIS", "Reportes"],
    catalogos: ["CONFIGURACIÓN", "Catálogos"],
    usuarios: ["SEGURIDAD", "Usuarios"],
    archivados: ["CONTROL", "Documentos archivados"],
  };

  return (
    <main className="page-shell">
      <div className="page-heading">
        <div><p className="eyebrow">{viewTitles[activeView][0]}</p><h1>{viewTitles[activeView][1]}</h1></div>
        <div className="session-box"><span>En sesión</span><strong>{currentUsername}</strong><small>{ROLE_LABELS[currentRole]}</small><button className="secondary" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button></div>
      </div>
      <nav className="main-menu" aria-label="Menú principal">
        {[["panel", "Panel"], ...(canOperate ? [["alta", "Alta"], ["boletas", "Boletas"], ["escanear", "Escanear"]] : []), ["consulta", "Buscar"], ["reportes", "Reportes"], ...(canManageAll ? [["catalogos", "Catálogos"], ["usuarios", "Usuarios"], ["archivados", "Archivados"]] : [])].map(([view, label]) => (
          <button className={activeView === view ? "active" : ""} key={view} onClick={() => setActiveView(view)}>{label}</button>
        ))}
      </nav>
      {activeView === "panel" && <section className="dashboard-view">
        <div className="welcome-card">
          <div>
            <p className="eyebrow">TRABAJO DE HOY</p>
            <h2>Elige qué vas a hacer</h2>
            <p>Botones grandes para la operación diaria: alta, envío, consulta y reportes.</p>
          </div>
          <div className="welcome-actions">
            <button onClick={() => setActiveView("alta")}>Nuevo expediente</button>
            <button className="secondary" onClick={() => setActiveView("escanear")}>Escanear documentos</button>
          </div>
        </div>
        <section className="quick-actions" aria-label="Acciones principales">
          {[
            ...(canOperate ? [["alta", "1", "Alta de expediente", "Agregar expediente y documentos"]] : []),
            ["consulta", "2", "Consultar documentos", "Buscar por expediente, tipo o dependencia"],
            ...(canOperate ? [["boletas", "3", "Capturar boletas", "Marcar enviados sin tener el QR"], ["escanear", "4", "Escanear regresos", "Autorizar o rechazar cuando regresen"]] : []),
            ["reportes", "5", "Ver reportes", "Filtrar, imprimir o exportar"],
            ...(canManageAll ? [["catalogos", "6", "Catálogos", "Tipos y dependencias sin errores"], ["usuarios", "7", "Usuarios", "Altas y permisos simples"]] : []),
          ].map(([view, step, title, text]) => (
            <button className="quick-action-card" key={view} onClick={() => setActiveView(view)}>
              <span>{step}</span>
              <strong>{title}</strong>
              <small>{text}</small>
            </button>
          ))}
        </section>
        <section className="dashboard-cards" aria-label="Resumen de documentos">
          {statusCards.map(([status, label]) => (
            <button className={`dashboard-card ${statusFilter === status ? "active" : ""}`} key={status} onClick={() => { setStatusFilter(status); setActiveView("consulta"); }}>
              <strong>{documents.filter((document) => document.status === status).length}</strong><span>{label}</span>
            </button>
          ))}
        </section>
      </section>}
      {activeView === "alta" && <>
      <section className="operation-strip" aria-label="Flujo de alta">
        <span>1. Guardar expediente</span>
        <span>2. Agregar documentos</span>
        <span>3. Imprimir QR</span>
        <span>4. Capturar boleta sin QR</span>
      </section>
      <div className="workspace-grid">
      <form className="panel case-panel" onSubmit={createCaseFile}>
        <div>
          <h2>Nuevo expediente</h2>
          <p>Escribe el número exactamente como aparece en tu otro programa.</p>
        </div>
        <label>Número de expediente<input value={number} onChange={(event) => setNumber(event.target.value)} placeholder="Ejemplo: 2548/2026" autoFocus required /></label>
        <button type="submit" disabled={busy}>{busy ? "Guardando…" : "Guardar expediente"}</button>
      </form>
      <form className="panel case-panel" onSubmit={createDocument}>
        <div><h2>Agregar documento</h2><p>Elige el expediente y captura los datos. Puedes agregar varias veces el mismo tipo de documento.</p></div>
        <label>Buscar expediente<input list="case-files" value={caseSearch} onChange={(event) => setCaseSearch(event.target.value)} placeholder="Escribe parte del número" required /></label>
        <datalist id="case-files">{caseFiles.map((caseFile) => <option key={caseFile.id} value={caseFile.number} />)}</datalist>
        <label>Tipo de documento<select value={documentType} onChange={(event) => changeDocumentType(event.target.value)} required><option value="">Seleccionar tipo</option>{availableDocumentTypes.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label>Identificador para distinguirlo (opcional)<input value={documentLabel} onChange={(event) => setDocumentLabel(event.target.value)} placeholder="Ejemplo: Original, Copia 1, Segundo certificado" maxLength="120" /></label>
        {documentType === "OTROS" ? <label>Dependencia manual<input list="agency-options" value={agency} onChange={(event) => setAgency(event.target.value)} placeholder="Escribe o selecciona dependencia" required /></label> : <label>Dependencia automática<select value={agency} onChange={(event) => setAgency(event.target.value)} required disabled={Boolean(DOCUMENT_AGENCY_MAP[documentType.toLocaleUpperCase("es-MX")])}><option value="">Seleccionar dependencia</option>{availableAgencies.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>}
        <datalist id="agency-options">{availableAgencies.map((name) => <option key={name} value={name} />)}</datalist>
        <button type="submit" disabled={busy}>{busy ? "Guardando…" : "Agregar documento"}</button>
      </form>
      </div>
      </>}
      {message && <div className={`notice page-notice ${message.type}`}>{message.text}</div>}

      {activeView === "boletas" && <section className="receipt-section standalone">
        <div className="receipt-heading">
          <div><p className="eyebrow">BOLETAS</p><h2>Capturar boletas de documentos enviados</h2><p>Usa esta pantalla cuando los documentos ya se quedaron en la dependencia y solo recibiste la boleta.</p></div>
          <strong>{receiptDocuments.length} listos</strong>
        </div>
        <label>Buscar expediente<input list="receipt-case-files" value={receiptCaseSearch} onChange={(event) => setReceiptCaseSearch(event.target.value)} placeholder="Escribe parte del número de expediente" /></label>
        <datalist id="receipt-case-files">{caseFiles.map((caseFile) => <option key={caseFile.id} value={caseFile.number} />)}</datalist>
        {receiptDocuments.length === 0 ? <p className="empty-state">No hay documentos listos para enviar con esa búsqueda.</p> : <div className="receipt-list">
          {receiptDocuments.map((document) => (
            <article className="receipt-row" key={document.id}>
              <div><strong>{document.case_files.number} · {formatDocumentName(document)}</strong><span>{document.agencies.name}</span></div>
              <label>Número de boleta<input value={receiptDrafts[document.id] ?? ""} onChange={(event) => setReceiptDrafts((current) => ({ ...current, [document.id]: event.target.value }))} placeholder="Ejemplo: B-12345" maxLength="100" /></label>
              <button onClick={() => registerReceiptSend(document)} disabled={busy}>Marcar ENVIADO</button>
            </article>
          ))}
        </div>}
      </section>}
      {activeView === "escanear" && <section className="scanner-section standalone">
        <div className="scanner-heading"><div><p className="eyebrow">OPERACIÓN RÁPIDA</p><h2>Escanear varios documentos</h2></div><span>Selecciona una operación una sola vez y escanea todos los documentos</span></div>
        <div className="scan-modes" aria-label="Operación automática al escanear">
          {[["ENVIADO", "ENVIADO"], ["AUTORIZADO", "AUTORIZADO"], ["RECHAZADO", "RECHAZADO"]].map(([status, label]) => (
            <button className={scanMode === status ? "active" : ""} key={status} onClick={() => activateScanMode(status)}>{label}</button>
          ))}
        </div>
        <p className="scan-mode-help">{scanMode ? `Modo activo: ${formatStatus(scanMode)}. Cada lectura se guardará automáticamente.` : "Sin modo automático: escanea un documento y después elige la acción."}</p>
        <p className="scan-mode-help">Si eliges ENVIADO y el documento ya tuvo un envío anterior, RASTREADOC lo registrará automáticamente como REINGRESADO.</p>
        {scanMode === "ENVIADO" && <div className="quick-rejection"><label>Número de boleta<input value={receiptNumber} onChange={(event) => setReceiptNumber(event.target.value)} placeholder="Captura la boleta de este documento" maxLength="100" required /></label><label>Observaciones (opcional)<input value={movementNotes} onChange={(event) => setMovementNotes(event.target.value)} /></label></div>}
        {scanMode === "RECHAZADO" && <div className="quick-rejection"><label>Motivo para estos rechazos (opcional)<input value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} maxLength="250" /></label><label>Observaciones (opcional)<input value={movementNotes} onChange={(event) => setMovementNotes(event.target.value)} /></label></div>}
        <form className="scan-form" onSubmit={scanDocument}>
          <input ref={scanInputRef} value={scanToken} onChange={(event) => setScanToken(event.target.value)} placeholder="Escanea el QR aquí" aria-label="Código QR" />
          <button type="submit" disabled={busy}>{scanMode ? "Registrar lectura" : "Buscar documento"}</button>
        </form>
        {scannedDocument && (
          <div className="scan-result">
            <div className="document-summary">
              <div><span>Expediente</span><strong>{scannedDocument.case_files.number}</strong></div>
              <div><span>Documento</span><strong>{formatDocumentName(scannedDocument)}</strong></div>
              <div><span>Dependencia</span><strong>{scannedDocument.agencies.name}</strong></div>
              <div><span>Estatus actual</span><strong className="status-pill">{formatStatus(scannedDocument.status)}</strong></div>
              <div><span>Último movimiento</span><strong>{new Date(scannedDocument.last_movement_at).toLocaleString("es-MX")}</strong></div>
              {isOutsideOffice(scannedDocument.status) && <div><span>Tiempo fuera</span><strong>{formatTimeOutside(scannedDocument.last_movement_at, currentTime)}</strong></div>}
            </div>
            {!scanMode && <div className="movement-fields">
              <label>Número de boleta (solo para enviar)<input value={receiptNumber} onChange={(event) => setReceiptNumber(event.target.value)} maxLength="100" /></label>
              <label>Motivo del rechazo (opcional)<input value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} maxLength="250" /></label>
              <label>Observaciones (opcional)<input value={movementNotes} onChange={(event) => setMovementNotes(event.target.value)} /></label>
            </div>}
            {!scanMode && <div className="movement-actions">
              <button onClick={() => registerMovement("ENVIADO")} disabled={busy}>Enviar</button>
              <button onClick={() => registerMovement("EN_OFICINA")} disabled={busy}>Recibir en oficina</button>
              <button onClick={() => registerMovement("AUTORIZADO")} disabled={busy}>Autorizar</button>
              <button className="danger-button" onClick={() => registerMovement("RECHAZADO")} disabled={busy}>Rechazar</button>
            </div>}
            {scanMode && manualMovementReady && <button className="quick-register" onClick={() => registerMovement(scanMode)} disabled={busy}>Registrar {formatStatus(scanMode)}</button>}
          </div>
        )}
      </section>}
      {activeView === "consulta" && <section className="documents-section standalone">
        <div className="documents-heading"><div><p className="eyebrow">CONSULTA</p><h2>Todos los documentos</h2></div><button className="secondary" onClick={printSelectedQrLabels}>Imprimir QR seleccionados ({selectedQrIds.length})</button></div>
        <div className="document-filters">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar expediente, documento o dependencia" aria-label="Buscar documentos" />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filtrar por estatus">
            <option value="">Todos los estatus</option>
            {statusCards.map(([status, label]) => <option value={status} key={status}>{label}</option>)}
          </select>
        </div>
        {filteredDocuments.length === 0 ? <p className="empty-state">No hay documentos que coincidan con la búsqueda.</p> : (
          <div className="documents-list">
            {filteredDocuments.map((document) => (
              <article className="document-row" key={document.id}>
                <div className="document-row-main">{document.status === "EN_OFICINA" && <label className="qr-select"><input type="checkbox" checked={selectedQrIds.includes(document.id)} onChange={() => toggleQrSelection(document.id)} /> QR</label>}<div><strong>{document.case_files.number} · {formatDocumentName(document)}</strong><span>{document.agencies.name} — {formatStatus(document.status)}</span>{isOutsideOffice(document.status) && <span className="time-outside">Fuera de la oficina: {formatTimeOutside(document.last_movement_at, currentTime)}</span>}</div></div>
                <div className="row-actions"><button onClick={() => setCasePreview(document.case_files.number)}>Ver expediente</button>{canOperate && <button onClick={() => prepareSend(document)}>Registrar envío</button>}{canManageAll && <button className="secondary" onClick={() => prepareCorrection(document)}>Editar estatus</button>}<button className="secondary" onClick={() => showHistory(document)} disabled={busy}>Historial</button><button className="secondary" onClick={() => showQr(document)}>Ver QR</button>{canManageAll && <button className="archive-button" onClick={() => archiveDocument(document)}>Archivar</button>}</div>
              </article>
            ))}
          </div>
        )}
      </section>}
      {activeView === "reportes" && <section className="reports-section">
        <div className="reports-heading"><div><p className="eyebrow">MOVIMIENTOS</p><h2>Reporte por fecha y tipo de documento</h2></div><strong>{filteredReportMovements.length} movimientos</strong></div>
        <div className="report-actions"><button onClick={() => openPrintableReport(true)}>Imprimir</button><button className="secondary" onClick={exportReportToExcel}>Exportar a Excel</button><button className="secondary" onClick={() => openPrintableReport(false)}>Ver PDF</button></div>
        <div className="report-filters">
          <label>Expediente<input list="report-case-files" value={reportCase} onChange={(event) => setReportCase(event.target.value)} placeholder="Escribe parte del número" /></label>
          <datalist id="report-case-files">{caseFiles.map((caseFile) => <option key={caseFile.id} value={caseFile.number} />)}</datalist>
          <label>Desde<input type="date" value={reportStart} onChange={(event) => setReportStart(event.target.value)} /></label>
          <label>Hasta<input type="date" value={reportEnd} onChange={(event) => setReportEnd(event.target.value)} /></label>
          <label>Estatus<select value={reportStatus} onChange={(event) => setReportStatus(event.target.value)}><option value="">Todos</option>{statusCards.map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label>
          <label>Tipo de documento<select value={reportType} onChange={(event) => setReportType(event.target.value)}><option value="">Todos</option>{availableDocumentTypes.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        </div>
        <div className="report-table-wrap"><table className="report-table"><thead><tr><th>Fecha</th><th>Expediente</th><th>Documento</th><th>Dependencia</th><th>Movimiento</th><th>Boleta</th></tr></thead><tbody>
          {filteredReportMovements.map((movement) => <tr key={movement.id}><td>{new Date(movement.occurred_at).toLocaleString("es-MX")}</td><td>{movement.documents?.case_files?.number}</td><td>{movement.documents ? formatDocumentName(movement.documents) : ""}</td><td>{movement.documents?.agencies?.name}</td><td><strong>{formatStatus(movement.status)}</strong></td><td>{movement.receipt_number || "—"}</td></tr>)}
          {filteredReportMovements.length === 0 && <tr><td colSpan="6">No hay movimientos que coincidan con estos filtros.</td></tr>}
        </tbody></table></div>
      </section>}

      {activeView === "catalogos" && <section className="catalogs-section standalone">
        <div className="catalogs-heading"><div><p className="eyebrow">CATÁLOGOS</p><h2>Tipos de documento y dependencias</h2><p>Agrega opciones aquí para evitar capturas diferentes del mismo dato.</p></div></div>
        <div className="catalogs-grid">
          <form className="catalog-card" onSubmit={(event) => addCatalogItem(event, "document_types", newDocumentTypeName, setNewDocumentTypeName, setDocumentTypes, "Tipo de documento")}>
            <h3>Tipos de documento</h3>
            <label>Nuevo tipo<input value={newDocumentTypeName} onChange={(event) => setNewDocumentTypeName(event.target.value)} placeholder="Ejemplo: PODER" /></label>
            <button type="submit" disabled={busy}>Agregar tipo</button>
            <div className="catalog-tags">{availableDocumentTypes.map((name) => <span key={name}>{name}</span>)}</div>
          </form>
          <form className="catalog-card" onSubmit={(event) => addCatalogItem(event, "agencies", newAgencyName, setNewAgencyName, setAgencies, "Dependencia")}>
            <h3>Dependencias</h3>
            <label>Nueva dependencia<input value={newAgencyName} onChange={(event) => setNewAgencyName(event.target.value)} placeholder="Ejemplo: SECRETARÍA" /></label>
            <button type="submit" disabled={busy}>Agregar dependencia</button>
            <div className="catalog-tags">{availableAgencies.map((name) => <span key={name}>{name}</span>)}</div>
          </form>
        </div>
      </section>}

      {activeView === "usuarios" && <section className="users-section standalone">
        <div className="users-heading"><div><p className="eyebrow">PERMISOS</p><h2>Usuarios del sistema</h2><p>El usuario entra con nombre de usuario y contraseña; no necesita escribir correo.</p></div><strong>{ROLE_LABELS[currentRole]}</strong></div>
        {!canManageUsers ? <p className="empty-state">Tu perfil solo permite consultar información.</p> : <div className="users-grid">
          <form className="user-card" onSubmit={createSystemUser}>
            <h3>Crear usuario</h3>
            <label>Usuario<input value={newUsername} onChange={(event) => setNewUsername(event.target.value)} placeholder="Ejemplo: supervisor1" required /></label>
            <label>Contraseña<input type="password" value={newUserPassword} onChange={(event) => setNewUserPassword(event.target.value)} placeholder="Mínimo 6 caracteres" required /></label>
            <label>Permiso<select value={newUserRole} onChange={(event) => setNewUserRole(event.target.value)}>{Object.entries(ROLE_LABELS).map(([role, label]) => <option key={role} value={role}>{label}</option>)}</select></label>
            <button type="submit" disabled={busy}>{busy ? "Creando…" : "Crear usuario"}</button>
          </form>
          <div className="user-card">
            <h3>Usuarios creados</h3>
            <div className="user-list">{profiles.length === 0 ? <p className="empty-state">Todavía no hay usuarios registrados en perfiles.</p> : profiles.map((profile) => <div className="user-list-row" key={profile.id}><div><strong>{profile.username}</strong><span>{ROLE_LABELS[profile.role] ?? profile.role}</span></div><label>Nueva contraseña<input type="password" value={passwordDrafts[profile.id] ?? ""} onChange={(event) => setPasswordDrafts((current) => ({ ...current, [profile.id]: event.target.value }))} placeholder="Mínimo 6 caracteres" /></label><button type="button" className="secondary" onClick={() => changeUserPassword(profile)} disabled={busy}>Cambiar contraseña</button><button type="button" className="archive-button" onClick={() => deleteSystemUser(profile)} disabled={busy || profile.id === session.user.id}>Eliminar</button></div>)}</div>
          </div>
        </div>}
      </section>}
      {activeView === "archivados" && <section className="archived-section">
        <div className="archived-heading"><div><p className="eyebrow">DOCUMENTOS OCULTOS</p><h2>Archivados</h2><p>Estos documentos no aparecen en la operación diaria, pero conservan todo su historial.</p></div><strong>{archivedDocuments.length} archivados</strong></div>
        {archivedDocuments.length === 0 ? <p className="empty-state">No hay documentos archivados.</p> : <div className="documents-list">
          {archivedDocuments.map((document) => <article className="document-row archived-row" key={document.id}><div><strong>{document.case_files.number} · {formatDocumentName(document)}</strong><span>{document.agencies.name} — {formatStatus(document.status)}</span><span>Archivado: {new Date(document.archived_at).toLocaleString("es-MX")}</span></div><div className="row-actions"><button onClick={() => restoreDocument(document)} disabled={busy}>Restaurar</button><button className="secondary" onClick={() => showHistory(document)} disabled={busy}>Historial</button></div></article>)}
        </div>}
      </section>}
      {casePreview && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Expediente ${casePreview}`}>
          <section className="case-modal">
            <button className="modal-close" onClick={() => setCasePreview(null)} aria-label="Cerrar">×</button>
            <p className="eyebrow">EXPEDIENTE</p>
            <h2>{casePreview}</h2>
            <p>{casePreviewDocuments.length} documentos activos relacionados</p>
            <div className="case-summary-grid" aria-label="Resumen del expediente">
              {caseStatusSummary.length === 0 ? <span>Sin documentos activos.</span> : caseStatusSummary.map(([status, label, count]) => (
                <button key={status} onClick={() => { setCasePreview(null); setStatusFilter(status); setSearch(casePreview); setActiveView("consulta"); }}>
                  <strong>{count}</strong>
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <div className="case-documents">
              {casePreviewDocuments.map((document) => (
                <article key={document.id} className="case-document-card">
                  <div>
                    <span>Documento</span>
                    <strong>{formatDocumentName(document)}</strong>
                    <small>{document.agencies.name}</small>
                  </div>
                  <div className="case-document-status">
                    <span>Estatus</span>
                    <b>{formatStatus(document.status)}</b>
                    {latestReceiptFor(document.id) && <small>Boleta: {latestReceiptFor(document.id)}</small>}
                  </div>
                  <div className="case-document-date">
                    <span>Último movimiento</span>
                    <strong>{new Date(document.last_movement_at).toLocaleString("es-MX")}</strong>
                    {isOutsideOffice(document.status) && <small className="time-outside">Fuera: {formatTimeOutside(document.last_movement_at, currentTime)}</small>}
                  </div>
                  <div className="case-document-actions">{canOperate && <button onClick={() => { setCasePreview(null); prepareSend(document); }}>Registrar envío</button>}{canManageAll && <button className="secondary" onClick={() => { setCasePreview(null); prepareCorrection(document); }}>Editar</button>}<button className="secondary" onClick={() => { setCasePreview(null); showHistory(document); }}>Historial</button><button className="secondary" onClick={() => { setCasePreview(null); showQr(document); }}>QR</button></div>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
      {qrPreview && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Código QR del documento">
          <section className="qr-modal">
            <button className="modal-close" onClick={() => setQrPreview(null)} aria-label="Cerrar">×</button>
            <p className="eyebrow">CÓDIGO QR</p>
            <h2>Expediente {qrPreview.document.case_files.number}</h2>
            <p>{formatDocumentName(qrPreview.document)} · {qrPreview.document.agencies.name}</p><small>Formato de impresión: etiqueta 40 × 30 mm</small>
            <img src={qrPreview.dataUrl} alt={`QR del expediente ${qrPreview.document.case_files.number}`} />
            <button onClick={printQr}>Imprimir etiqueta 40 × 30 mm</button>
          </section>
        </div>
      )}
      {historyPreview && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Historial del documento">
          <section className="history-modal">
            <button className="modal-close" onClick={() => setHistoryPreview(null)} aria-label="Cerrar">×</button>
            <p className="eyebrow">HISTORIAL COMPLETO</p>
            <h2>{historyPreview.document.case_files.number}</h2>
            <p className="history-document-name">{formatDocumentName(historyPreview.document)} · {historyPreview.document.agencies.name}</p>
            <ol className="timeline">
              {historyPreview.movements.map((movement) => (
                <li key={movement.id}><span>{new Date(movement.occurred_at).toLocaleString("es-MX")}</span><strong>{formatStatus(movement.status)}</strong>{movement.receipt_number && <p><b>Boleta:</b> {movement.receipt_number}</p>}{movement.rejection_reason && <p><b>Motivo:</b> {movement.rejection_reason}</p>}{movement.notes && <p><b>Observaciones:</b> {movement.notes}</p>}</li>
              ))}
            </ol>
          </section>
        </div>
      )}
      {editPreview && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Corregir estatus del documento">
          <form className="edit-modal" onSubmit={saveStatusCorrection}>
            <button type="button" className="modal-close" onClick={() => setEditPreview(null)} aria-label="Cerrar">×</button>
            <p className="eyebrow">CORRECCIÓN</p>
            <h2>Editar estatus</h2>
            <p>{editPreview.case_files.number} · {formatDocumentName(editPreview)}</p>
            <div className="status-change-preview"><span>Actual</span><strong>{formatStatus(editPreview.status)}</strong><span>Nuevo</span><strong>{formatStatus(correctedStatus)}</strong></div>
            <label>Estatus correcto<select value={correctedStatus} onChange={(event) => setCorrectedStatus(event.target.value)}>{statusCards.map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label>
            <label>Motivo de la corrección (opcional)<input value={correctionNote} onChange={(event) => setCorrectionNote(event.target.value)} placeholder="Ejemplo: Se seleccionó rechazado por error" /></label>
            <div className="edit-actions"><button type="button" className="secondary" onClick={() => setEditPreview(null)}>Cancelar</button><button type="submit" disabled={busy}>Guardar corrección</button></div>
            <small>El movimiento anterior permanecerá en el historial para proteger la información.</small>
          </form>
        </div>
      )}
    </main>
  );
}
