"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import SectionErrorBoundary from "./section-error-boundary";
import { refreshAfterSave, scanLookupMessage } from "@/lib/operation-feedback.mjs";
import { createDocumentOperationClient, documentOperationArguments } from "@/lib/document-operations.mjs";
import { createDocumentCreationClient } from "@/lib/document-creation.mjs";
import { createCaseFileCreationClient } from "@/lib/case-file-creation.mjs";
import { findCatalogRecord, indexReportMovements } from "@/lib/office-lookups.mjs";
import { buildQrPrintHtml, createQrImageCache, preloadQrLibrary } from "@/lib/qr-labels.mjs";
import { authErrorMessage, createSessionRecovery, withAuthDeadline } from "@/lib/auth-recovery.mjs";
import { formatOfficeDateTime, matchesReportDateRange, officeDateKey, reportDateRangeError } from "@/lib/office-dates.mjs";
import { dataLoadErrorMessage, loadCompleteData } from "@/lib/data-loading.mjs";

const supabase = createClient();
const DEFAULT_DOCUMENT_TYPES = [
  "CERTIFICADO", "AVISO PREVENTIVO", "ESCRITURA", "ACTA", "ISAI",
  "INFORME TEST. REGISTRO", "INFORME TEST. ARCHIVO", "FIRMA CANCELACION INFONAVIT", "OTROS",
];
const DEFAULT_AGENCIES = [
  "REGISTRO PÚBLICO", "TESORERÍA MUNICIPAL", "ARCHIVO GENERAL DE NOTARÍAS", "INFONAVIT",
];
const USER_DOMAIN = "usuarios.rastreadoc.mx";
const SUPABASE_PAGE_SIZE = 1000;
const DATABASE_STORAGE_LIMIT_BYTES = (Number(process.env.NEXT_PUBLIC_DATABASE_STORAGE_LIMIT_MB) || 500) * 1024 ** 2;
const ROLE_LABELS = {
  admin: "Administrador",
  supervisor: "Supervisor",
  empleado: "Empleado",
  consulta: "Consulta",
};
const DOCUMENT_SELECT = "id, qr_token, label, lawyer_id, auxiliary_id, folio_forma, municipality, cadastral_file_number, deed_entries, status, last_movement_at, archived_at, case_files(number), document_types(name), agencies(name)";
const LEGACY_DOCUMENT_SELECT = "id, qr_token, label, status, last_movement_at, archived_at, case_files(number), document_types(name), agencies(name)";
const REPORT_MOVEMENT_SELECT = "id, status, occurred_at, receipt_number, documents!inner(id, label, status, archived_at, case_files(number), document_types(name), agencies(name))";

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
  "FIRMA CANCELACION INFONAVIT": "INFONAVIT",
  "FIRMA CANCELACIÓN INFONAVIT": "INFONAVIT",
};

async function fetchAllPages(buildQuery, signal) {
  const rows = [];

  for (let from = 0; ; from += SUPABASE_PAGE_SIZE) {
    if (signal?.aborted) throw signal.reason;
    const query = buildQuery(from, from + SUPABASE_PAGE_SIZE - 1);
    const { data, error } = await (signal ? query.abortSignal(signal) : query);
    if (error) return { data: null, error };
    if (!Array.isArray(data)) return { data: null, error: new Error("Incomplete page response.") };
    const page = data;
    rows.push(...page);
    if (page.length < SUPABASE_PAGE_SIZE) return { data: rows, error: null };
  }
}

function fetchReportMovements(signal) {
  return fetchAllPages((from, to) => supabase
    .from("movements")
    .select(REPORT_MOVEMENT_SELECT)
    .not("receipt_number", "is", null)
    .is("documents.archived_at", null)
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to), signal);
}

async function fetchDocuments(archived = false, signal) {
  const buildQuery = (select, from, to) => {
    let query = supabase
      .from("documents")
      .select(select);

    // Supabase's filters do not share the same signature: `is` receives two
    // arguments while `not` receives three. Keep the calls explicit so active
    // documents use `archived_at=is.null`, not the invalid `is.is` filter.
    query = archived
      ? query.not("archived_at", "is", null)
      : query.is("archived_at", null);

    return query
      .order(archived ? "archived_at" : "created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to);
  };

  const result = await fetchAllPages((from, to) => buildQuery(DOCUMENT_SELECT, from, to), signal);
  if (!result.error) return result;
  if (signal?.aborted || !["42703", "PGRST204"].includes(result.error.code)) return result;

  // Keep existing records visible while PostgREST refreshes its schema cache or
  // when the optional deed/catalog migration has not reached this environment.
  // New fields remain empty, but a missing column must never blank the dashboard.
  const fallback = await fetchAllPages((from, to) => buildQuery(LEGACY_DOCUMENT_SELECT, from, to), signal);
  if (fallback.error) return fallback;

  return {
    data: fallback.data.map((document) => ({
      ...document,
      lawyer_id: null,
      auxiliary_id: null,
      folio_forma: null,
      municipality: null,
      cadastral_file_number: null,
      deed_entries: [],
    })),
    error: null,
  };
}

async function fetchCaseFiles(signal) {
  const fetchWithSelect = (select) => fetchAllPages((from, to) => supabase
    .from("case_files")
    .select(select)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to), signal);
  return fetchWithSelect("id, number");
}

function usernameToEmail(username) {
  const cleanUsername = username.trim().toLocaleLowerCase("es-MX").replace(/\s+/g, "_");
  return cleanUsername.includes("@") ? cleanUsername : `${cleanUsername}@${USER_DOMAIN}`;
}

function formatDocumentName(document) {
  const label = document.label?.trim();
  return label ? `${document.document_types.name} — ${label}` : document.document_types.name;
}

function isIsaiDocument(document) {
  return document?.document_types?.name?.trim().toLocaleUpperCase("es-MX") === "ISAI";
}

function isDeedType(typeName) {
  return typeName?.trim().toLocaleUpperCase("es-MX") === "ESCRITURA";
}

const emptyDeedEntry = () => ({ folio_forma: "", municipality: "", cadastral_file_number: "" });

function documentDeedEntries(document) {
  if (Array.isArray(document?.deed_entries) && document.deed_entries.length > 0) return document.deed_entries;
  if (document?.folio_forma || document?.municipality || document?.cadastral_file_number) {
    return [{ folio_forma: document.folio_forma ?? "", municipality: document.municipality ?? "", cadastral_file_number: document.cadastral_file_number ?? "" }];
  }
  return [];
}

function deedColumn(document, field) {
  return documentDeedEntries(document).map((entry) => entry[field]).filter(Boolean).join("; ");
}

function formatStorageSize(bytes) {
  if (!Number.isFinite(bytes)) return "No disponible";
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function storageLevel(percentage) {
  if (percentage >= 90) return { className: "critical", message: "Espacio casi agotado. Libera espacio o amplía la capacidad." };
  if (percentage >= 75) return { className: "warning", message: "El almacenamiento comienza a llenarse. Conviene revisarlo." };
  return { className: "healthy", message: "El almacenamiento tiene espacio suficiente." };
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

function elapsedDays(date, currentTime) {
  return Math.max(0, Math.floor((currentTime - new Date(date).getTime()) / 86400000));
}

function statusTimeLabel(status) {
  if (status === "EN_OFICINA") return "Listo para enviar desde hace";
  if (status === "RECHAZADO") return "Rechazado desde hace";
  if (isOutsideOffice(status)) return "Fuera de la oficina";
  return "En el estatus actual desde hace";
}

function sortByElapsedTime(items, direction, getDate, currentTime) {
  if (!direction) return items;
  const multiplier = direction === "desc" ? -1 : 1;
  return [...items].sort((first, second) => (
    elapsedDays(getDate(first), currentTime) - elapsedDays(getDate(second), currentTime)
  ) * multiplier);
}

function isOutsideOffice(status) {
  return ["ENVIADO", "REENVIADO"].includes(status);
}

function overdueCategory(document, currentTime) {
  const days = elapsedDays(document.last_movement_at, currentTime);
  if (document.status === "RECHAZADO" && days > 5) return "REJECTED_OVERDUE";
  if (!isOutsideOffice(document.status)) return "";

  const agency = document.agencies?.name?.trim().toLocaleUpperCase("es-MX") ?? "";
  if (agency.includes("REGISTRO") && days > 30) return "SENT_OVERDUE";
  if (agency.includes("TESORERÍA") && days > 15) return "SENT_OVERDUE";
  return "";
}

function isObsoleteAgencyName(name) {
  const upperName = name.trim().toLocaleUpperCase("es-MX");
  return upperName.startsWith("RESISTO PUBLICO")
    || upperName.startsWith("RESISTO PÚBLICO")
    || upperName.startsWith("REGISTRÓ PUBLICO")
    || upperName.startsWith("REGISTRÓ PÚBLICO");
}

function normalizeScannedToken(value) {
  const cleanValue = value.trim();
  const uuid = cleanValue.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) return uuid[0].toLowerCase();

  // Algunos lectores configurados con un teclado distinto sustituyen los dos
  // puntos y guiones del QR (por ejemplo, "RDOC:" puede llegar como "RDOCÑ").
  // Después del prefijo solo esperamos los 32 caracteres hexadecimales del UUID,
  // así que podemos reconstruirlo sin depender de esos signos del teclado.
  const prefixPosition = cleanValue.toUpperCase().indexOf("RDOC");
  const tokenPart = prefixPosition >= 0 ? cleanValue.slice(prefixPosition + 4) : cleanValue;
  const compactUuid = tokenPart.replace(/[^0-9a-f]/gi, "").toLowerCase();

  if (compactUuid.length === 32) {
    return `${compactUuid.slice(0, 8)}-${compactUuid.slice(8, 12)}-${compactUuid.slice(12, 16)}-${compactUuid.slice(16, 20)}-${compactUuid.slice(20)}`;
  }

  return tokenPart.trim();
}

export default function HomePage({ initialView = "panel" } = {}) {
  const [session, setSession] = useState(null);
  const sessionUserId = session?.user?.id;
  const sessionEmail = session?.user?.email;
  const [loadingSession, setLoadingSession] = useState(true);
  const [authMessage, setAuthMessage] = useState(null);
  const [sessionRecoveryError, setSessionRecoveryError] = useState(null);
  const [dataLoad, setDataLoad] = useState(null);
  const [dataLoadAttempt, setDataLoadAttempt] = useState(0);
  const sessionRecoveryRef = useRef(null);
  const signInInFlight = useRef(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [number, setNumber] = useState("");
  const [caseFiles, setCaseFiles] = useState([]);
  const [caseSearch, setCaseSearch] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [documentLabel, setDocumentLabel] = useState("");
  const [deedEntries, setDeedEntries] = useState(() => [emptyDeedEntry()]);
  const [lawyerId, setLawyerId] = useState("");
  const [auxiliaryId, setAuxiliaryId] = useState("");
  const [agency, setAgency] = useState("");
  const [documentTypes, setDocumentTypes] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [lawyers, setLawyers] = useState([]);
  const [auxiliaries, setAuxiliaries] = useState([]);
  const [municipalities, setMunicipalities] = useState([]);
  const [newDocumentTypeName, setNewDocumentTypeName] = useState("");
  const [newAgencyName, setNewAgencyName] = useState("");
  const [newLawyerName, setNewLawyerName] = useState("");
  const [newAuxiliaryName, setNewAuxiliaryName] = useState("");
  const [newMunicipalityName, setNewMunicipalityName] = useState("");
  const [documents, setDocuments] = useState([]);
  const [archivedDocuments, setArchivedDocuments] = useState([]);
  const [qrPreview, setQrPreview] = useState(null);
  const [qrTask, setQrTask] = useState(null);
  const qrWorkInFlight = useRef(false);
  const lastLabelWindow = useRef(null);
  const [qrImages] = useState(() => createQrImageCache());
  const [recentCreation, setRecentCreation] = useState(null);
  const lastCreatedDocument = recentCreation && recentCreation.userId === sessionUserId ? recentCreation.document : null;
  const [selectedQrIds, setSelectedQrIds] = useState([]);
  const [scanToken, setScanToken] = useState("");
  const [scannedDocument, setScannedDocument] = useState(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [movementNotes, setMovementNotes] = useState("");
  const [receiptNumber, setReceiptNumber] = useState("");
  const [manualMovementReady, setManualMovementReady] = useState(false);
  const [editPreview, setEditPreview] = useState(null);
  const [correctedStatus, setCorrectedStatus] = useState("");
  const [correctedDocumentLabel, setCorrectedDocumentLabel] = useState("");
  const [correctionNote, setCorrectionNote] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [searchDaySort, setSearchDaySort] = useState("");
  const [historyPreview, setHistoryPreview] = useState(null);
  const [scanMode, setScanMode] = useState("");
  const [activeView, setActiveView] = useState(initialView);
  const [receiptCaseSearch, setReceiptCaseSearch] = useState("");
  const [receiptDrafts, setReceiptDrafts] = useState({});
  const [reportMovements, setReportMovements] = useState([]);
  const [reportStatus, setReportStatus] = useState("");
  const [reportType, setReportType] = useState("");
  const [reportStart, setReportStart] = useState("");
  const [reportEnd, setReportEnd] = useState("");
  const [reportCase, setReportCase] = useState("");
  const [reportLawyer, setReportLawyer] = useState("");
  const [reportAuxiliary, setReportAuxiliary] = useState("");
  const [reportAlert, setReportAlert] = useState("");
  const [reportDaySort, setReportDaySort] = useState("");
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
  const [storageUsage, setStorageUsage] = useState(null);
  const [storageError, setStorageError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingSave, setPendingSave] = useState(null);
  const [pendingCreation, setPendingCreation] = useState(false);
  const [pendingCaseCreation, setPendingCaseCreation] = useState(false);
  const caseCreationInFlight = useRef(false);
  const creationInFlight = useRef(false);
  const [processingScan, setProcessingScan] = useState(false);
  const [operationClient] = useState(() => createDocumentOperationClient(
    (args) => supabase.rpc("save_document_operation", args).abortSignal(AbortSignal.timeout(20000)),
  ));
  const [creationClient] = useState(() => createDocumentCreationClient({
    insert: (input) => supabase.from("documents").insert(input).select(DOCUMENT_SELECT)
      .single().abortSignal(AbortSignal.timeout(20000)),
    find: (id) => supabase.from("documents").select(DOCUMENT_SELECT).eq("id", id)
      .maybeSingle().abortSignal(AbortSignal.timeout(20000)),
  }));
  const [caseCreationClient] = useState(() => createCaseFileCreationClient({
    insert: (input, signal) => supabase.from("case_files").insert(input).select("id, number").single().abortSignal(signal),
    findById: (id, signal) => supabase.from("case_files").select("id, number").eq("id", id).maybeSingle().abortSignal(signal),
    findByNumber: (value, signal) => supabase.from("case_files").select("id, number").eq("number", value).maybeSingle().abortSignal(signal),
  }));
  const scanInFlight = useRef(false);
  const reportRefreshVersion = useRef(0);
  const documentSaveBlocked = busy || processingScan || Boolean(pendingSave) || pendingCreation || pendingCaseCreation;
  const reportRangeError = reportDateRangeError(reportStart, reportEnd);

  useEffect(() => {
    if (activeView === "escanear" && !documentSaveBlocked) scanInputRef.current?.focus();
  }, [activeView, documentSaveBlocked]);

  useEffect(() => {
    if (!pendingCreation && !pendingSave && !pendingCaseCreation) return;
    const preserveVerification = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preserveVerification);
    return () => window.removeEventListener("beforeunload", preserveVerification);
  }, [pendingCreation, pendingSave, pendingCaseCreation]);

  function openView(view) {
    setActiveView(view);
  }

  useEffect(() => {
    if (!sessionUserId) return;
    const warm = () => {
      preloadQrLibrary().then(() => lastCreatedDocument
        ? qrImages.get(lastCreatedDocument.qr_token) : undefined).catch(() => {});
    };
    if (window.requestIdleCallback) {
      const task = window.requestIdleCallback(warm, { timeout: 1500 });
      return () => window.cancelIdleCallback(task);
    }
    const task = window.setTimeout(warm, 0);
    return () => window.clearTimeout(task);
  }, [sessionUserId, lastCreatedDocument, qrImages]);

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;

    const recovery = createSessionRecovery({
      getSession: () => supabase.auth.getSession(),
      onSession: (nextSession) => {
        setSession(nextSession);
        if (!nextSession) setDataLoad(null);
      },
      onError: setSessionRecoveryError,
      onLoading: setLoadingSession,
    });
    sessionRecoveryRef.current = recovery;

    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      // An empty INITIAL_SESSION must not hide a failed recovery. getSession
      // handles that result; later sign-in/out events supersede older reads.
      if (event !== "INITIAL_SESSION" || nextSession) recovery.accept(nextSession);
    });
    recovery.load();

    return () => {
      recovery.dispose();
      if (sessionRecoveryRef.current === recovery) sessionRecoveryRef.current = null;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!sessionUserId) return;
    let active = true;
    const controller = new AbortController();

    loadCompleteData([
      (signal) => fetchCaseFiles(signal),
      (signal) => supabase.from("document_types").select("id, name").order("name").abortSignal(signal),
      (signal) => supabase.from("agencies").select("id, name").order("name").abortSignal(signal),
      (signal) => supabase.from("lawyers").select("id, name").order("name").abortSignal(signal),
      (signal) => supabase.from("auxiliaries").select("id, name").order("name").abortSignal(signal),
      (signal) => supabase.from("municipalities").select("id, name").order("name").abortSignal(signal),
      (signal) => supabase.from("profiles").select("id, username, role").order("created_at", { ascending: false }).abortSignal(signal),
      (signal) => fetchDocuments(false, signal),
      (signal) => fetchDocuments(true, signal),
      (signal) => fetchReportMovements(signal),
    ], { signal: controller.signal }).then(([loadedCases, loadedTypes, loadedAgencies, loadedLawyers, loadedAuxiliaries, loadedMunicipalities, loadedProfiles, loadedDocuments, loadedArchives, loadedMovements]) => {
      if (!active) return;
      setCaseFiles(loadedCases);
      setDocumentTypes(loadedTypes);
      setAgencies(loadedAgencies);
      const lawyersById = new Map(loadedLawyers.map((lawyer) => [lawyer.id, lawyer]));
      const auxiliariesById = new Map(loadedAuxiliaries.map((auxiliaryRecord) => [auxiliaryRecord.id, auxiliaryRecord]));
      const attachCatalogs = (document) => ({
        ...document,
        lawyers: lawyersById.get(document.lawyer_id) ?? null,
        auxiliaries: auxiliariesById.get(document.auxiliary_id) ?? null,
      });
      setLawyers(loadedLawyers);
      setAuxiliaries(loadedAuxiliaries);
      setMunicipalities(loadedMunicipalities);
      setProfiles(loadedProfiles);
      const sessionProfile = loadedProfiles.find((profile) => profile.id === sessionUserId);
      setCurrentRole(sessionProfile?.role ?? "admin");
      setCurrentUsername(sessionProfile?.username ?? sessionEmail?.split("@")[0] ?? "usuario");
      setDocuments(loadedDocuments.map(attachCatalogs));
      setArchivedDocuments(loadedArchives.map(attachCatalogs));
      setReportMovements(loadedMovements);
      setDataLoad({ userId: sessionUserId, email: sessionEmail, attempt: dataLoadAttempt, status: "ready", error: null });
      if (sessionProfile?.role === "admin") refreshStorageUsage();
    }).catch((error) => {
      if (active) setDataLoad({ userId: sessionUserId, email: sessionEmail, attempt: dataLoadAttempt, status: "error", error: dataLoadErrorMessage(error) });
    });
    return () => { active = false; controller.abort(); };
  }, [sessionUserId, sessionEmail, dataLoadAttempt]);

  async function refreshReportAfterSave(successText) {
    const version = ++reportRefreshVersion.current;
    setMessage({ type: "success", text: successText });
    await refreshAfterSave(fetchReportMovements, setReportMovements, () => {
      setMessage({
        type: "error",
        text: `${successText} No se pudo actualizar el reporte. Los datos del reporte pueden estar desactualizados; recarga la página. No repitas la operación.`,
      });
    }, () => reportRefreshVersion.current === version);
  }

  async function refreshStorageUsage() {
    setStorageError(false);
    try {
      const { data, error } = await supabase.rpc("get_database_storage_usage").abortSignal(AbortSignal.timeout(20000));
      if (error) throw error;
      setStorageUsage(Number(data));
    } catch {
      setStorageUsage(null);
      setStorageError(true);
    }
  }

  async function signIn(event) {
    event.preventDefault();
    if (signInInFlight.current) return;
    signInInFlight.current = true;
    sessionRecoveryRef.current?.invalidate();
    setBusy(true);
    reportRefreshVersion.current += 1;
    setMessage(null);
    setAuthMessage(null);
    setSessionRecoveryError(null);
    try {
      const { data, error } = await withAuthDeadline(() => supabase.auth.signInWithPassword({ email: usernameToEmail(email), password }));
      if (error) setAuthMessage(authErrorMessage(error));
      else if (data?.session) {
        sessionRecoveryRef.current?.accept(data.session);
        setPassword("");
      } else setAuthMessage(authErrorMessage(null));
    } catch (error) {
      setAuthMessage(authErrorMessage(error));
    } finally {
      signInInFlight.current = false;
      setBusy(false);
    }
  }

  async function createSystemUser(event) {
    event.preventDefault();
    setBusy(true);
    reportRefreshVersion.current += 1;
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
    reportRefreshVersion.current += 1;
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
    reportRefreshVersion.current += 1;
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
    if (documentSaveBlocked || caseCreationInFlight.current || caseCreationClient.hasPending()
      || creationInFlight.current || creationClient.hasPending() || operationClient.isInFlight() || operationClient.hasPending()) return;
    const cleanNumber = number.trim();
    if (!cleanNumber) return;
    caseCreationInFlight.current = true;
    setPendingCaseCreation(true);
    setBusy(true);
    reportRefreshVersion.current += 1;
    setMessage(null);
    try {
      finishCaseCreation(await caseCreationClient.save(cleanNumber));
    } catch {
      finishCaseCreation({ kind: caseCreationClient.hasPending() ? "uncertain" : "failed" });
    } finally {
      caseCreationInFlight.current = false;
      setBusy(false);
    }
  }

  function finishCaseCreation(result) {
    setPendingCaseCreation(caseCreationClient.hasPending());
    if (result.kind === "uncertain") {
      setMessage({ scope: "caseCreation", type: "error", text: "No se pudo confirmar el expediente. Podría haberse guardado. Pulsa Verificar expediente antes de volver a capturarlo o recargar." });
      return;
    }
    if (result.kind === "failed") {
      setMessage({ scope: "caseCreation", type: "error", text: "No se guardó el expediente. Revisa el número y vuelve a intentar; si continúa, comunícalo al administrador de la oficina." });
      return;
    }
    if (!["saved", "existing"].includes(result.kind)) return;
    const data = result.data;
    setNumber("");
    setCaseFiles((current) => [data, ...current.filter((item) => item.id !== data.id)]);
    setCaseSearch(data.number);
    setMessage({ scope: "caseCreation", type: "success", text: result.kind === "existing"
      ? `El expediente ${data.number} ya existe. Se seleccionó para agregar documentos.`
      : `Expediente ${data.number} guardado correctamente.` });
  }

  async function verifyCaseCreation() {
    if (caseCreationInFlight.current || !caseCreationClient.hasPending()) return;
    caseCreationInFlight.current = true;
    setBusy(true);
    try { finishCaseCreation(await caseCreationClient.verify()); }
    finally { caseCreationInFlight.current = false; setBusy(false); }
  }

  async function findOrCreate(table, name) {
    const cleanName = name.trim();
    const existing = await supabase.from(table).select("id, name").eq("name", cleanName).maybeSingle()
      .abortSignal(AbortSignal.timeout(20000));
    if (existing.error) return null;
    if (existing.data) return existing.data;

    const created = await supabase.from(table).insert({ name: cleanName }).select("id, name").single()
      .abortSignal(AbortSignal.timeout(20000));
    if (created.data) return created.data;

    const repeated = await supabase.from(table).select("id, name").eq("name", cleanName).single()
      .abortSignal(AbortSignal.timeout(20000));
    return repeated.data;
  }

  function changeDocumentType(nextType) {
    setDocumentType(nextType);
    const mappedAgency = DOCUMENT_AGENCY_MAP[nextType.toLocaleUpperCase("es-MX")];
    if (mappedAgency) setAgency(mappedAgency);
    if (!nextType || nextType === "OTROS") setAgency("");
    if (!isDeedType(nextType)) {
      setDeedEntries([emptyDeedEntry()]);
    }
  }

  function updateDeedEntry(index, field, value) {
    setDeedEntries((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, [field]: value } : entry));
  }

  async function addCatalogItem(event, table, value, setter, collectionSetter, successLabel) {
    event.preventDefault();
    const cleanName = value.trim().toLocaleUpperCase("es-MX");
    if (!cleanName) return;

    if (table === "agencies" && isObsoleteAgencyName(cleanName)) {
      setMessage({ type: "error", text: "Esa dependencia no es válida. Utiliza REGISTRO PÚBLICO." });
      return;
    }

    setBusy(true);
    reportRefreshVersion.current += 1;
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

  async function deleteCatalogItem(table, record, collectionSetter, itemLabel) {
    const confirmed = window.confirm(`¿Eliminar ${itemLabel.toLocaleLowerCase("es-MX")} "${record.name}"?`);
    if (!confirmed) return;

    setBusy(true);
    reportRefreshVersion.current += 1;
    setMessage(null);
    const { error } = await supabase.from(table).delete().eq("id", record.id);
    setBusy(false);

    if (error?.code === "23503") {
      setMessage({ type: "error", text: `No se puede eliminar ${record.name} porque ya está siendo utilizado por uno o más documentos.` });
      return;
    }

    if (error) {
      setMessage({ type: "error", text: `No fue posible eliminar ${itemLabel.toLocaleLowerCase("es-MX")}.` });
      return;
    }

    collectionSetter((current) => current.filter(({ id }) => id !== record.id));
    setMessage({ type: "success", text: `${itemLabel} eliminado correctamente.` });
  }

  async function createDocument(event) {
    event.preventDefault();
    if (creationInFlight.current || creationClient.hasPending() || caseCreationInFlight.current || caseCreationClient.hasPending()
      || operationClient.isInFlight() || operationClient.hasPending()) return;
    const selectedCase = caseFiles.find((caseFile) => caseFile.number.toLocaleLowerCase("es-MX") === caseSearch.trim().toLocaleLowerCase("es-MX"));
    if (!selectedCase) {
      setMessage({ type: "error", text: "Selecciona un expediente existente de la búsqueda." });
      return;
    }
    if (!documentType.trim() || !agency.trim() || !lawyerId || !auxiliaryId) return;

    creationInFlight.current = true;
    setBusy(true);
    reportRefreshVersion.current += 1;
    setMessage(null);
    try {
      // Catalogs are already loaded. Only query/create an entry when absent.
      const [typeRecord, agencyRecord] = await Promise.all([
        findCatalogRecord(documentTypes, documentType) || findOrCreate("document_types", documentType),
        findCatalogRecord(agencies, agency) || findOrCreate("agencies", agency),
      ]);
      if (!typeRecord || !agencyRecord) {
        setMessage({ type: "error", text: "No fue posible preparar el tipo o la dependencia. Revisa tu conexión y los datos de captura." });
        return;
      }
      setDocumentTypes((current) => current.some(({ id }) => id === typeRecord.id) ? current : [...current, typeRecord]);
      setAgencies((current) => current.some(({ id }) => id === agencyRecord.id) ? current : [...current, agencyRecord]);
      const cleanDeedEntries = isDeedType(documentType) ? deedEntries.map((entry) => ({
        folio_forma: entry.folio_forma.trim(),
        municipality: entry.municipality.trim(),
        cadastral_file_number: entry.cadastral_file_number.trim(),
      })) : [];
      const firstDeedEntry = cleanDeedEntries[0];
      const result = await creationClient.save({
        case_file_id: selectedCase.id,
        document_type_id: typeRecord.id,
        agency_id: agencyRecord.id,
        lawyer_id: lawyerId,
        auxiliary_id: auxiliaryId,
        label: documentLabel.trim() || null,
        folio_forma: firstDeedEntry?.folio_forma || null,
        municipality: firstDeedEntry?.municipality || null,
        cadastral_file_number: firstDeedEntry?.cadastral_file_number || null,
        deed_entries: cleanDeedEntries,
        status: "EN_OFICINA",
      });
      finishDocumentCreation(result);
    } catch {
      setMessage({ type: "error", text: "No fue posible preparar el alta. Revisa tu conexión y los datos de captura." });
    } finally {
      creationInFlight.current = false;
      setBusy(false);
    }
  }

  function finishDocumentCreation(result) {
    if (result.kind === "uncertain") {
      setPendingCreation(true);
      setMessage({ type: "error", text: "No se pudo confirmar el alta. El documento podría haberse guardado. Usa Verificar alta antes de recargar o capturarlo de nuevo." });
      return;
    }
    if (result.kind === "failed") {
      setPendingCreation(false);
      setMessage({ type: "error", text: "El alta no se guardó. Revisa el expediente y los catálogos; conserva los datos de captura para volver a intentar." });
      return;
    }
    if (result.kind !== "saved") return;
    setPendingCreation(false);
    const data = result.data;
    const created = {
      ...data,
      lawyers: lawyers.find((lawyer) => lawyer.id === data.lawyer_id) ?? null,
      auxiliaries: auxiliaries.find((auxiliary) => auxiliary.id === data.auxiliary_id) ?? null,
    };
    setDocuments((current) => created.archived_at ? current.filter((item) => item.id !== created.id)
      : current.some((item) => item.id === created.id)
        ? current.map((item) => item.id === created.id ? created : item) : [created, ...current]);
    setArchivedDocuments((current) => !created.archived_at ? current.filter((item) => item.id !== created.id)
      : current.some((item) => item.id === created.id)
        ? current.map((item) => item.id === created.id ? created : item) : [created, ...current]);
    setRecentCreation({ userId: sessionUserId, document: created });
    setDocumentType("");
    setDocumentLabel("");
    setDeedEntries([emptyDeedEntry()]);
    setAgency("");
    setLawyerId("");
    setAuxiliaryId("");
    // A new document's initial movement has no receipt. The report already
    // derives its rows from documents, so no history download is needed here.
    setMessage({ type: "success", text: `Documento guardado. Estatus actual: ${formatStatus(created.status)}. ${created.archived_at ? "Puedes consultarlo en Archivados." : "Su QR está disponible para imprimir."}` });
  }

  async function verifyDocumentCreation() {
    if (creationInFlight.current || !creationClient.hasPending()) return;
    creationInFlight.current = true;
    setBusy(true);
    try { finishDocumentCreation(await creationClient.verify()); }
    finally {
      creationInFlight.current = false;
      setBusy(false);
    }
  }

  async function showQr(document) {
    if (qrWorkInFlight.current) return;
    qrWorkInFlight.current = true;
    setQrTask({ done: 0, total: 1 });
    setQrPreview({ document, dataUrl: null, error: false });
    try {
      const dataUrl = await qrImages.get(document.qr_token);
      setQrPreview((current) => current?.document.id === document.id ? { document, dataUrl, error: false } : current);
    } catch {
      setQrPreview((current) => current?.document.id === document.id ? { ...current, error: true } : current);
    } finally {
      qrWorkInFlight.current = false;
      setQrTask(null);
    }
  }

  function buildLabelHtml(document, dataUrl) {
    return `<section class="label"><img class="qr" src="${dataUrl}"><div class="info"><div class="case">${escapeHtml(document.case_files.number)}</div><div class="document-type">${escapeHtml(document.document_types.name)}</div></div></section>`;
  }

  function labelPrintStyles() {
    return `@page{size:40mm 30mm;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0}body{font-family:Arial,sans-serif;color:#111}.label{width:40mm;height:30mm;display:grid;grid-template-columns:20mm 1fr;gap:1.2mm;align-items:center;padding:1.5mm;overflow:hidden;break-after:page;page-break-after:always}.label:last-child{break-after:auto;page-break-after:auto}.qr{width:20mm;height:20mm}.info{height:20mm;min-width:0;display:flex;align-items:center;justify-content:center;gap:1.2mm;overflow:hidden}.case,.document-type{max-height:20mm;writing-mode:vertical-rl;text-orientation:mixed;overflow:hidden}.case{font-size:8pt;font-weight:800;line-height:1.1;white-space:nowrap}.document-type{font-size:6pt;font-weight:600;line-height:1.15;overflow-wrap:anywhere}@media screen{body{display:grid;place-items:center;gap:8px;min-height:100vh;background:#eee}.label{background:white;border:1px solid #ddd;transform:scale(2.5);transform-origin:center;margin:26mm}}@media print{button{display:none}}`;
  }

  function openLabelWindow(key) {
    const previous = lastLabelWindow.current;
    if (previous?.key === key && !previous.popup.closed) {
      previous.popup.focus();
      return null;
    }
    const popup = window.open("", "_blank", "width=900,height=700");
    if (!popup) {
      const text = "El navegador bloqueó la ventana de impresión. Permite las ventanas emergentes para este sitio y vuelve a intentar.";
      setMessage({ type: "error", text });
      setQrPreview((current) => current ? { ...current, printError: text } : current);
      return null;
    }
    lastLabelWindow.current = { key, popup };
    popup.document.write('<!doctype html><html lang="es"><head><title>Preparando etiquetas RASTREADOC</title></head><body><p>Preparando etiquetas…</p></body></html>');
    popup.document.close();
    return popup;
  }

  function printQr() {
    if (!qrPreview?.dataUrl || qrWorkInFlight.current) return;
    const { document, dataUrl } = qrPreview;
    const popup = openLabelWindow(document.id);
    if (!popup) return;
    popup.document.write(buildQrPrintHtml({ title: `QR ${document.case_files.number}`, labels: [buildLabelHtml(document, dataUrl)], styles: labelPrintStyles() }));
    popup.document.close();
  }

  async function printSelectedQrLabels() {
    if (qrWorkInFlight.current) return;
    const selectedIds = new Set(selectedQrIds);
    const selectedDocuments = documents.filter((document) => selectedIds.has(document.id) && document.status === "EN_OFICINA");
    if (selectedDocuments.length === 0) {
      setMessage({ type: "error", text: "Selecciona al menos un documento listo para enviar." });
      return;
    }

    // Open inside the click event, before awaiting image generation, so popup
    // blockers do not discard a fully prepared batch of labels.
    const popup = openLabelWindow(selectedDocuments.map(({ id }) => id).join(","));
    if (!popup) return;
    qrWorkInFlight.current = true;
    setQrTask({ done: 0, total: selectedDocuments.length });
    try {
      const labels = [];
      for (const document of selectedDocuments) {
        if (popup.closed) return;
        const dataUrl = await qrImages.get(document.qr_token);
        labels.push(buildLabelHtml(document, dataUrl));
        if (labels.length % 8 === 0 || labels.length === selectedDocuments.length) {
          setQrTask({ done: labels.length, total: selectedDocuments.length });
          // Yield between small batches while keeping the original label order.
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
      }
      if (popup.closed) return;
      popup.document.write(buildQrPrintHtml({ title: "Etiquetas RASTREADOC", labels, styles: labelPrintStyles() }));
      popup.document.close();
    } catch {
      if (!popup.closed) popup.close();
      setMessage({ type: "error", text: "No fue posible preparar todos los QR. Vuelve a intentar la impresión de las etiquetas seleccionadas." });
    } finally {
      qrWorkInFlight.current = false;
      setQrTask(null);
    }
  }

  function toggleQrSelection(documentId) {
    setSelectedQrIds((current) => current.includes(documentId) ? current.filter((id) => id !== documentId) : [...current, documentId]);
  }

  function applyServerDocument(saved, original) {
    const merged = { ...original, ...saved };
    setDocuments((current) => {
      if (saved.archived_at) return current.filter(({ id }) => id !== saved.id);
      if (current.some(({ id }) => id === saved.id)) {
        return current.map((item) => item.id === saved.id ? { ...item, ...saved } : item);
      }
      return merged.case_files ? [merged, ...current] : current;
    });
    setArchivedDocuments((current) => {
      if (!saved.archived_at) return current.filter(({ id }) => id !== saved.id);
      if (current.some(({ id }) => id === saved.id)) {
        return current.map((item) => item.id === saved.id ? { ...item, ...saved } : item);
      }
      return merged.case_files ? [merged, ...current] : current;
    });
    setScannedDocument((current) => current?.id === saved.id
      ? (saved.archived_at ? null : { ...current, ...saved }) : current);
  }

  async function persistDocumentChange(document, changes, retry = false) {
    if (operationClient.isInFlight() || creationInFlight.current || creationClient.hasPending()) return null;
    setBusy(true);
    reportRefreshVersion.current += 1;
    setMessage(null);
    try {
      const result = retry ? await operationClient.retry()
        : await operationClient.save(documentOperationArguments(document, changes));
      if (result.kind === "saved") {
        setPendingSave(null);
        applyServerDocument(result.data.document, document);
        return result.data;
      }
      if (["uncertain", "pending"].includes(result.kind)) {
        setPendingSave((current) => current ?? { document });
        setMessage({ type: "error", text: "No se pudo confirmar el guardado. El cambio podría haberse registrado. Usa Verificar guardado para comprobar la misma operación antes de continuar." });
      } else if (result.kind === "conflict") {
        setPendingSave(null);
        // Reload the document, but require the user to review the new state.
        let refreshed = false;
        try {
          const { data, error } = await supabase.from("documents")
            .select(DOCUMENT_SELECT).eq("id", document.id).maybeSingle()
            .abortSignal(AbortSignal.timeout(20000));
          if (!error && data) {
            applyServerDocument(data, document);
            refreshed = true;
          }
        } catch { /* The conflict is still reported if the refresh fails. */ }
        if (editPreview?.id === document.id) setEditPreview(null);
        setMessage({ type: "error", text: refreshed
          ? "El documento cambió desde que lo abriste. Se actualizó su información; revísala antes de intentar otro cambio. Esta operación no se guardó."
          : "El documento cambió desde que lo abriste y no pudimos actualizar su información. Recarga la página y revisa su historial antes de continuar. Esta operación no se guardó." });
      } else if (result.kind === "invalid") {
        setPendingSave(null);
        setMessage({ type: "error", text: result.error.message || "Revisa los datos de la operación. No se guardó ningún cambio." });
      } else if (result.kind === "unavailable") {
        setPendingSave(null);
        setMessage({ type: "error", text: "El guardado no está disponible o la sesión requiere iniciar de nuevo. No se guardó ningún cambio. Si continúa, comunícalo al administrador." });
      }
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function verifyPendingSave() {
    if (!pendingSave) return;
    const result = await persistDocumentChange(pendingSave.document, null, true);
    if (!result) return;
    setReceiptDrafts((current) => ({ ...current, [result.document.id]: "" }));
    setReceiptNumber("");
    setRejectionReason("");
    setMovementNotes("");
    setManualMovementReady(false);
    setEditPreview(null);
    await refreshReportAfterSave(`Guardado confirmado. Estatus actual: ${formatStatus(result.document.status)}.`);
  }

  async function scanDocument(event) {
    event.preventDefault();
    if (scanInFlight.current || operationClient.isInFlight() || operationClient.hasPending()
      || creationInFlight.current || creationClient.hasPending()) return;
    const token = normalizeScannedToken(scanToken);
    if (!token) return;
    scanInFlight.current = true;
    setProcessingScan(true);
    setBusy(true);
    reportRefreshVersion.current += 1;
    setMessage(null);
    try {
      let result;
      try {
        result = await supabase.from("documents").select(DOCUMENT_SELECT)
          .eq("qr_token", token).is("archived_at", null).maybeSingle()
          .abortSignal(AbortSignal.timeout(20000));
      } catch {
        result = { data: null, error: { message: "Consulta interrumpida" } };
      }
      const { data, error } = result;
      if (error || !data) {
        setScannedDocument(null);
        setMessage({ type: "error", text: scanLookupMessage(error, data) });
        return;
      }
      setScannedDocument(data);
      setManualMovementReady(false);
      setScanToken("");
      if (scanMode) await registerMovement(scanMode, data);
    } finally {
      scanInFlight.current = false;
      setProcessingScan(false);
      setBusy(false);
    }
  }

  function confirmSensitiveMovement(status, document) {
    if (!document || !["AUTORIZADO", "RECHAZADO"].includes(status)) return true;
    return window.confirm(`Vas a marcar ${formatDocumentName(document)} del expediente ${document.case_files.number} como ${formatStatus(status)}. ¿Confirmas que es correcto?`);
  }

  function activateScanMode(status) {
    if (scanInFlight.current || operationClient.isInFlight() || operationClient.hasPending()) return;
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
    if (!targetDocument || operationClient.isInFlight()) return;
    if (!scanMode && !confirmSensitiveMovement(status, targetDocument)) return;
    if (status === "ENVIADO" && !isIsaiDocument(targetDocument) && !receiptNumber.trim()) {
      setMessage({ type: "error", text: "Escribe el número de boleta antes de registrar el envío." });
      return;
    }
    const result = await persistDocumentChange(targetDocument, {
      status,
      rejectionReason: status === "RECHAZADO" ? rejectionReason.trim() || null : null,
      notes: movementNotes.trim() || null,
      receiptNumber: ["ENVIADO", "REENVIADO"].includes(status) && !isIsaiDocument(targetDocument)
        ? receiptNumber.trim() || null : null,
    });
    if (!result) return;
    if (!scanMode) {
      setRejectionReason("");
      setMovementNotes("");
    }
    if (["ENVIADO", "REENVIADO"].includes(result.recorded_status)) setReceiptNumber("");
    setManualMovementReady(false);
    await refreshReportAfterSave(`Movimiento registrado: ${formatStatus(result.recorded_status)}.`);
  }

  async function registerReceiptSend(document) {
    const cleanReceipt = (receiptDrafts[document.id] ?? "").trim();
    if (!isIsaiDocument(document) && !cleanReceipt) {
      setMessage({ type: "error", text: "Escribe el número de boleta antes de marcar el documento como enviado." });
      return;
    }
    const result = await persistDocumentChange(document, {
      status: "ENVIADO",
      receiptNumber: cleanReceipt || null,
      notes: isIsaiDocument(document) ? "Envío de ISAI sin número de boleta" : "Captura de boleta sin escaneo QR",
    });
    if (!result) return;
    setReceiptDrafts((current) => ({ ...current, [document.id]: "" }));
    await refreshReportAfterSave(`Boleta guardada. Documento marcado como ${formatStatus(result.recorded_status)}.`);
  }

  async function markRejectedDocumentReady(document) {
    if (operationClient.isInFlight()) return;
    const confirmed = window.confirm(`¿Marcar ${formatDocumentName(document)} del expediente ${document.case_files.number} como listo para enviar nuevamente?`);
    if (!confirmed) return;
    const result = await persistDocumentChange(document, {
      status: "EN_OFICINA", notes: "Documento corregido y listo para reenviar",
    });
    if (!result) return;
    await refreshReportAfterSave("Documento listo para enviar. Ya aparece en Boletas; al capturar su número se marcará como REINGRESADO.");
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
    if (operationClient.isInFlight() || operationClient.hasPending()) return;
    setScannedDocument(document);
    setScanMode("ENVIADO");
    setReceiptNumber("");
    setMovementNotes("");
    setManualMovementReady(true);
    setActiveView("escanear");
    reportRefreshVersion.current += 1;
    setMessage(null);
  }

  function prepareCorrection(document) {
    if (operationClient.isInFlight() || operationClient.hasPending()) return;
    reportRefreshVersion.current += 1;
    setMessage(null);
    setEditPreview(document);
    setCorrectedStatus(document.status);
    setCorrectedDocumentLabel(document.label ?? "");
    setCorrectionNote("");
  }

  async function saveStatusCorrection(event) {
    event.preventDefault();
    if (!editPreview || !correctedStatus || operationClient.isInFlight()) return;
    const cleanLabel = correctedDocumentLabel.trim();
    const statusChanged = correctedStatus !== editPreview.status;
    const labelChanged = cleanLabel !== (editPreview.label?.trim() ?? "");
    if (!statusChanged && !labelChanged) {
      setEditPreview(null);
      setMessage({ type: "success", text: "No había cambios por guardar." });
      return;
    }
    const confirmed = window.confirm(`¿Guardar los cambios de ${formatDocumentName(editPreview)}?`);
    if (!confirmed) return;
    const note = correctionNote.trim()
      ? `CORRECCIÓN DE CAPTURA: ${correctionNote.trim()}` : "CORRECCIÓN DE CAPTURA";
    const result = await persistDocumentChange(editPreview, {
      status: statusChanged ? correctedStatus : null,
      changeLabel: labelChanged,
      label: cleanLabel || null,
      notes: note,
      isCorrection: true,
    });
    if (!result) return;
    setEditPreview(null);
    await refreshReportAfterSave("Cambios del documento guardados correctamente.");
  }

  async function archiveDocument(document) {
    const confirmed = window.confirm(`Vas a archivar ${formatDocumentName(document)} del expediente ${document.case_files.number}. No se borrará el historial, solo se ocultará de la operación diaria. ¿Confirmas?`);
    if (!confirmed) return;
    setBusy(true);
    reportRefreshVersion.current += 1;
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
    setReportMovements((current) => current.filter((movement) => movement.documents?.id !== document.id));
    if (scannedDocument?.id === document.id) setScannedDocument(null);
    setMessage({ type: "success", text: "Documento archivado. Su historial se conservó." });
  }

  async function restoreDocument(document) {
    setBusy(true);
    reportRefreshVersion.current += 1;
    setMessage(null);
    const { error } = await supabase.from("documents").update({ archived_at: null }).eq("id", document.id);
    setBusy(false);

    if (error) {
      setMessage({ type: "error", text: "No fue posible restaurar el documento." });
      return;
    }

    setArchivedDocuments((current) => current.filter((item) => item.id !== document.id));
    setDocuments((current) => [{ ...document, archived_at: null }, ...current]);
    await refreshReportAfterSave("Documento restaurado y disponible nuevamente.");
  }

  function exportReportToExcel() {
    if (reportRangeError) {
      setMessage({ type: "error", text: reportRangeError });
      return;
    }
    const headers = ["Último movimiento", "Días en estatus", "Expediente", "Auxiliar", "Documento", "Folio forma", "Municipio", "No. de Exp. Catastral", "Abogado", "Dependencia", "Estatus actual", "Número de boleta", "Quién recibe", "Firma"];
    const safeCsvCell = (value) => {
      let text = String(value ?? "");
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = filteredReportDocuments.map((movement) => [
      movement.date_label,
      elapsedDays(movement.occurred_at, currentTime),
      movement.documents?.case_files?.number,
      movement.documents?.auxiliaries?.name || "",
      movement.documents ? formatDocumentName(movement.documents) : "",
      deedColumn(movement.documents, "folio_forma"),
      deedColumn(movement.documents, "municipality"),
      deedColumn(movement.documents, "cadastral_file_number"),
      movement.documents?.lawyers?.name || "",
      movement.documents?.agencies?.name,
      formatStatus(movement.documents?.status),
      movement.receipt_number || "",
      "",
      "",
    ]);
    const csv = [headers, ...rows].map((row) => row.map(safeCsvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `reporte-rastreadoc-${officeDateKey(Date.now())}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function openPrintableReport(autoPrint) {
    if (reportRangeError) {
      setMessage({ type: "error", text: reportRangeError });
      return;
    }
    const popup = window.open("", "_blank", "width=1100,height=750");
    if (!popup) return;
    const rows = filteredReportDocuments.map((movement) => `<tr><td>${escapeHtml(movement.date_label)}</td><td>${elapsedDays(movement.occurred_at, currentTime)}</td><td>${escapeHtml(movement.documents?.case_files?.number)}</td><td>${escapeHtml(movement.documents?.auxiliaries?.name || "—")}</td><td>${escapeHtml(movement.documents ? formatDocumentName(movement.documents) : "")}</td><td>${escapeHtml(deedColumn(movement.documents, "folio_forma") || "—")}</td><td>${escapeHtml(deedColumn(movement.documents, "municipality") || "—")}</td><td>${escapeHtml(deedColumn(movement.documents, "cadastral_file_number") || "—")}</td><td>${escapeHtml(movement.documents?.lawyers?.name || "—")}</td><td>${escapeHtml(movement.documents?.agencies?.name)}</td><td>${escapeHtml(formatStatus(movement.documents?.status))}</td><td>${escapeHtml(movement.receipt_number || "—")}</td><td class="signature-line"></td><td class="signature-line"></td></tr>`).join("");
    const alertLabel = reportAlert === "SENT_OVERDUE" ? "Enviados vencidos" : reportAlert === "REJECTED_OVERDUE" ? "Rechazados vencidos" : "";
    const filters = [alertLabel && `Seguimiento: ${alertLabel}`, reportCase && `Expediente: ${reportCase}`, reportStart && `Desde: ${reportStart}`, reportEnd && `Hasta: ${reportEnd}`, reportStatus && `Estatus: ${formatStatus(reportStatus)}`, reportType && `Tipo: ${reportType}`, reportLawyer && `Abogado: ${lawyers.find(({ id }) => id === reportLawyer)?.name}`, reportAuxiliary && `Auxiliar: ${auxiliaries.find(({ id }) => id === reportAuxiliary)?.name}`].filter(Boolean).join(" · ") || "Todos los movimientos";
    popup.document.write(`<!doctype html><html lang="es"><head><title>Reporte RASTREADOC</title><style>@page{size:landscape;margin:8mm}body{font-family:Arial;margin:32px;color:#17232d}header{border-bottom:3px solid #18324a;margin-bottom:24px;padding-bottom:14px}h1{margin:0;color:#18324a}p{color:#667580}.toolbar{margin-bottom:20px}.toolbar button{padding:10px 18px;border:0;border-radius:6px;background:#246b8e;color:white;font-weight:bold}table{width:100%;border-collapse:collapse;font-size:9px}th,td{padding:7px 5px;border-bottom:1px solid #dce3e8;text-align:left}th{background:#f4f6f7}.signature-line{min-width:75px;border-bottom:1px solid #17232d}@media print{.toolbar{display:none}body{margin:8mm}}</style></head><body><div class="toolbar"><button onclick="window.print()">Guardar como PDF / Imprimir</button></div><header><h1>RASTREADOC</h1><p>Reporte de documentos actuales — ${escapeHtml(filters)}</p><p>Fechas y horas de la Ciudad de México.</p><strong>${filteredReportDocuments.length} documentos</strong></header><table><thead><tr><th>Último movimiento</th><th>Días en estatus</th><th>Expediente</th><th>Auxiliar</th><th>Documento</th><th>Folio forma</th><th>Municipio</th><th>No. de Exp. Catastral</th><th>Abogado</th><th>Dependencia</th><th>Estatus actual</th><th>Número de boleta</th><th>Quién recibe</th><th>Firma</th></tr></thead><tbody>${rows || '<tr><td colspan="14">No hay documentos para mostrar.</td></tr>'}</tbody></table>${autoPrint ? '<script>window.onload=()=>window.print()</script>' : ""}</body></html>`);
    popup.document.close();
  }

  const reportIndexes = useMemo(() => indexReportMovements(reportMovements), [reportMovements]);
  const documentDates = useMemo(() => activeView === "reportes" ? new Map(documents.map((document) => [document.id, {
    day: officeDateKey(document.last_movement_at),
    label: formatOfficeDateTime(document.last_movement_at),
  }])) : null, [documents, activeView]);
  // Keep every active document, including those without a receipt, and use its
  // current server status/time rather than a historical movement's snapshot.
  const latestReportDocuments = useMemo(() => documentDates ? documents.map((document) => ({
    id: document.id,
    occurred_at: document.last_movement_at,
    date_key: documentDates.get(document.id).day,
    date_label: documentDates.get(document.id).label,
    receipt_number: reportIndexes.latest.get(document.id)?.receipt_number ?? null,
    documents: document,
  })) : [], [documents, reportIndexes, documentDates]);

  if (!isSupabaseConfigured) {
    return <main className="center-shell"><section className="panel"><h1>Falta configurar Supabase</h1><p>Agrega en Vercel las variables NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY para este ambiente y vuelve a desplegar.</p></section></main>;
  }

  if (loadingSession) {
    return <main className="center-shell"><p role="status">Recuperando tu sesión…</p></main>;
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
          <p>Ingresa con tu usuario de la oficina.</p>
          <label>Usuario o correo<input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Ejemplo: supervisor" required disabled={busy} /></label>
          <label>Contraseña<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} /></label>
          {(authMessage || sessionRecoveryError) && <div role="status" aria-live="polite" className="notice error">{authMessage || sessionRecoveryError}</div>}
          <button type="submit" disabled={busy}>{busy ? "Ingresando…" : "Ingresar"}</button>
          {sessionRecoveryError && <button type="button" className="secondary" disabled={busy} onClick={() => { setAuthMessage(null); sessionRecoveryRef.current?.load(); }}>Reintentar sesión</button>}
        </form>
      </main>
    );
  }

  const dataIsCurrent = dataLoad?.userId === sessionUserId && dataLoad?.email === sessionEmail && dataLoad?.attempt === dataLoadAttempt;
  if (!dataIsCurrent || dataLoad.status !== "ready") {
    const failed = dataIsCurrent && dataLoad.status === "error";
    return <main className="center-shell"><section className="panel data-load-panel" aria-busy={!failed}>
      <p className="eyebrow">RASTREADOC</p>
      <h1>{failed ? "No se pudo cargar la información" : "Cargando información…"}</h1>
      <p role={failed ? "alert" : "status"}>{failed ? dataLoad.error : "Estamos cargando tus expedientes y documentos. Espera un momento."}</p>
      {failed && <button onClick={() => setDataLoadAttempt((attempt) => attempt + 1)}>Reintentar carga</button>}
      <button className="secondary" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button>
    </section></main>;
  }

  const normalizedSearch = search.trim().toLocaleLowerCase("es-MX");
  const matchingDocuments = documents.filter((document) => {
    const matchesText = !normalizedSearch || [
      document.case_files.number,
      formatDocumentName(document),
      document.agencies.name,
    ].some((value) => value.toLocaleLowerCase("es-MX").includes(normalizedSearch));
    return matchesText && (!statusFilter || document.status === statusFilter);
  });
  const filteredDocuments = sortByElapsedTime(matchingDocuments, searchDaySort, (document) => document.last_movement_at, currentTime);
  const statusCards = [
    ["EN_OFICINA", "Listos para enviar"], ["ENVIADO", "Enviados"],
    ["RECHAZADO", "Rechazados"], ["AUTORIZADO", "Autorizados"],
    ["REENVIADO", "Reingresados"],
  ];
  const canManageAll = ["admin", "supervisor"].includes(currentRole);
  const canOperate = canManageAll || currentRole === "empleado";
  const canManageUsers = canManageAll;
  const availableDocumentTypes = [...new Set([...DEFAULT_DOCUMENT_TYPES, ...documentTypes.map(({ name }) => name).filter((name) => !["PREPRE", "REGISTRO"].includes(name.toLocaleUpperCase("es-MX")))])].sort((a, b) => a.localeCompare(b, "es"));
  const availableAgencies = [...new Set([...DEFAULT_AGENCIES, ...agencies.map(({ name }) => name)].filter((name) => !isObsoleteAgencyName(name)))].sort((a, b) => a.localeCompare(b, "es"));
    const overdueSentDocuments = documents.filter((document) => overdueCategory(document, currentTime) === "SENT_OVERDUE");
  const overdueRejectedDocuments = documents.filter((document) => overdueCategory(document, currentTime) === "REJECTED_OVERDUE");
  // El reporte y el panel deben partir de la misma lista de documentos actuales.
  // Usar el historial como fuente hacía que faltaran documentos cuando la consulta
  // de movimientos alcanzaba el límite de filas de Supabase.
  const matchingReportDocuments = latestReportDocuments.filter((movement) => {
    if (!movement.documents || movement.documents.archived_at) return false;
    const caseNumber = movement.documents?.case_files?.number ?? "";
    return matchesReportDateRange(movement.date_key, reportStart, reportEnd)
      && (!reportStatus || movement.documents.status === reportStatus)
      && (!reportType || movement.documents?.document_types?.name === reportType)
      && (!reportLawyer || movement.documents?.lawyer_id === reportLawyer)
      && (!reportAuxiliary || movement.documents?.auxiliary_id === reportAuxiliary)
      && (!reportAlert || overdueCategory(movement.documents, currentTime) === reportAlert)
      && (!reportCase.trim() || caseNumber.toLocaleLowerCase("es-MX").includes(reportCase.trim().toLocaleLowerCase("es-MX")));
  });
  const filteredReportDocuments = sortByElapsedTime(matchingReportDocuments, reportDaySort, (movement) => movement.occurred_at, currentTime);
  const casePreviewDocuments = casePreview
    ? documents.filter((document) => document.case_files.number === casePreview)
    : [];
  const caseStatusSummary = statusCards
    .map(([status, label]) => [status, label, casePreviewDocuments.filter((document) => document.status === status).length])
    .filter(([, , count]) => count > 0);
  const normalizedReceiptCaseSearch = receiptCaseSearch.trim().toLocaleLowerCase("es-MX");
  const receiptDocuments = documents.filter((document) => document.status === "EN_OFICINA" && (!normalizedReceiptCaseSearch || document.case_files.number.toLocaleLowerCase("es-MX").includes(normalizedReceiptCaseSearch)));
  const latestReceiptFor = (documentId) => reportIndexes.receipts.get(documentId);
  const storagePercentage = storageUsage === null ? 0 : Math.min(100, (storageUsage / DATABASE_STORAGE_LIMIT_BYTES) * 100);
  const storageStatus = storageLevel(storagePercentage);
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
  const caseFeedback = <>
    {message?.scope === "caseCreation" && <div role="status" aria-live="polite" className={`notice ${activeView === "alta" ? "" : "page-notice"} ${message.type}`}>{message.text}</div>}
    {pendingCaseCreation && <div className={activeView === "alta" ? "case-creation-verify" : "page-notice"}><button type="button" className="secondary" onClick={verifyCaseCreation} disabled={busy}>{busy ? "Procesando expediente…" : "Verificar expediente"}</button></div>}
  </>;

  return (
    <main className="page-shell">
      <div className="page-heading">
        <div><p className="eyebrow">{viewTitles[activeView][0]}</p><h1>{viewTitles[activeView][1]}</h1></div>
        <div className="session-box"><span>En sesión</span><strong>{currentUsername}</strong><small>{ROLE_LABELS[currentRole]}</small><button className="secondary" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button></div>
      </div>
      <nav className="main-menu" aria-label="Menú principal">
        {[["panel", "Panel"], ...(canOperate ? [["alta", "Alta"], ["boletas", "Boletas"], ["escanear", "Escanear"]] : []), ["consulta", "Buscar"], ["reportes", "Reportes"], ["archivados", "Archivados"], ...(canManageAll ? [["catalogos", "Catálogos"], ["usuarios", "Usuarios"]] : [])].map(([view, label]) => (
          <button className={activeView === view ? "active" : ""} key={view} onClick={() => openView(view)}>{label}</button>
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
            <button onClick={() => openView("alta")}>Nuevo expediente</button>
            <button className="secondary" onClick={() => setActiveView("escanear")}>Escanear documentos</button>
          </div>
        </div>
        <section className="quick-actions" aria-label="Acciones principales">
          {[
            ...(canOperate ? [["alta", "1", "Alta de expediente", "Agregar expediente y documentos"]] : []),
            ["consulta", "2", "Consultar documentos", "Buscar por expediente, tipo o dependencia"],
            ...(canOperate ? [["boletas", "3", "Capturar boletas", "Marcar enviados sin tener el QR"], ["escanear", "4", "Escanear regresos", "Autorizar o rechazar cuando regresen"]] : []),
            ["reportes", "5", "Ver reportes", "Filtrar, imprimir o exportar"],
            ["archivados", "6", "Ver archivados", "Consultar y restaurar documentos ocultos"],
            ...(canManageAll ? [["catalogos", "7", "Catálogos", "Tipos y dependencias sin errores"], ["usuarios", "8", "Usuarios", "Altas y permisos simples"]] : []),
          ].map(([view, step, title, text]) => (
            <button className="quick-action-card" key={view} onClick={() => openView(view)}>
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
        {(overdueSentDocuments.length > 0 || overdueRejectedDocuments.length > 0) && <section className="overdue-alert" role="alert" aria-label="Documentos que requieren atención">
          <div><p className="eyebrow">ATENCIÓN</p><h3>Hay documentos que excedieron el tiempo de seguimiento</h3><p>Consulta el reporte para dar seguimiento a los documentos enviados o rechazados.</p></div>
          <div className="overdue-alert-actions">
            {overdueSentDocuments.length > 0 && <button onClick={() => { setReportAlert("SENT_OVERDUE"); setActiveView("reportes"); }}><strong>{overdueSentDocuments.length}</strong><span>Enviados vencidos</span><small>Registro: más de 30 días · Tesorería: más de 15 días</small></button>}
            {overdueRejectedDocuments.length > 0 && <button onClick={() => { setReportAlert("REJECTED_OVERDUE"); setActiveView("reportes"); }}><strong>{overdueRejectedDocuments.length}</strong><span>Rechazados vencidos</span><small>Más de 5 días en rechazo</small></button>}
          </div>
        </section>}
        {currentRole === "admin" && <section className={`storage-card ${storageStatus.className}`} aria-label="Almacenamiento de la base de datos">
          <div className="storage-details"><p className="eyebrow">ALMACENAMIENTO</p><h3>Espacio utilizado por RASTREADOC</h3><strong>{storageError ? "No disponible" : storageUsage === null ? "Consultando…" : `${formatStorageSize(storageUsage)} de ${formatStorageSize(DATABASE_STORAGE_LIMIT_BYTES)}`}</strong>{!storageError && storageUsage !== null && <><div className="storage-meter" role="progressbar" aria-label="Porcentaje de almacenamiento utilizado" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(storagePercentage)}><span style={{ width: `${storagePercentage}%` }} /></div><p className="storage-reading"><b>{storagePercentage.toFixed(1)}% utilizado</b> · Quedan aproximadamente {formatStorageSize(Math.max(0, DATABASE_STORAGE_LIMIT_BYTES - storageUsage))}</p><p className="storage-alert">{storageStatus.message}</p></>}<p>Incluye expedientes, documentos, movimientos, usuarios y catálogos. Límite configurado: {formatStorageSize(DATABASE_STORAGE_LIMIT_BYTES)}.</p></div>
          <button className="secondary" onClick={refreshStorageUsage}>Actualizar</button>
        </section>}
      </section>}
      {activeView === "alta" && <>
      <section className="operation-strip" aria-label="Flujo de alta">
        <span>1. Guardar expediente</span>
        <span>2. Agregar documentos</span>
        <span>3. Imprimir QR</span>
        <span>4. Capturar boleta sin QR</span>
      </section>
      <div className="workspace-grid">
      <div className="case-creation-column">
      <form className="panel case-panel" onSubmit={createCaseFile}>
        <div>
          <h2>Nuevo expediente</h2>
          <p>Escribe el número exactamente como aparece en tu otro programa.</p>
        </div>
        <label>Número de expediente<input value={number} onChange={(event) => setNumber(event.target.value)} placeholder="Ejemplo: 2548/2026" autoFocus required disabled={documentSaveBlocked} /></label>
        <button type="submit" disabled={documentSaveBlocked}>{busy ? "Guardando…" : "Guardar expediente"}</button>
      </form>
      {caseFeedback}
      </div>
      <SectionErrorBoundary render={() => (
      <form className="panel case-panel" onSubmit={createDocument}>
        <div><h2>Agregar documento</h2><p>Elige el expediente y captura los datos. Puedes agregar varias veces el mismo tipo de documento.</p></div>
        <fieldset className="document-fields" disabled={documentSaveBlocked}>
        <label>Buscar expediente<input list="case-files" value={caseSearch} onChange={(event) => setCaseSearch(event.target.value)} placeholder="Escribe parte del número" required /></label>
        <datalist id="case-files">{caseFiles.map((caseFile) => <option key={caseFile.id} value={caseFile.number} />)}</datalist>
        <label>Tipo de documento<select value={documentType} onChange={(event) => changeDocumentType(event.target.value)} required><option value="">Seleccionar tipo</option>{availableDocumentTypes.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
        <label>Abogado<select value={lawyerId} onChange={(event) => setLawyerId(event.target.value)} required><option value="">Seleccionar abogado</option>{lawyers.map((lawyer) => <option key={lawyer.id} value={lawyer.id}>{lawyer.name}</option>)}</select></label>
        <label>Auxiliar<select value={auxiliaryId} onChange={(event) => setAuxiliaryId(event.target.value)} required><option value="">Seleccionar auxiliar</option>{auxiliaries.map((auxiliaryRecord) => <option key={auxiliaryRecord.id} value={auxiliaryRecord.id}>{auxiliaryRecord.name}</option>)}</select></label>
        <label>Identificador para distinguirlo (opcional)<input value={documentLabel} onChange={(event) => setDocumentLabel(event.target.value)} placeholder="Ejemplo: Original, Copia 1, Segundo certificado" maxLength="120" /></label>
        {isDeedType(documentType) && <div className="deed-entry-list">
          {deedEntries.map((entry, index) => <fieldset className="deed-entry" key={index}>
            <legend>Datos de Lote {index + 1}</legend>
            <div className="deed-fields">
              <label>Folio forma<input value={entry.folio_forma} onChange={(event) => updateDeedEntry(index, "folio_forma", event.target.value)} maxLength="120" required /></label>
              <label>Municipio<input list="municipality-options" value={entry.municipality} onChange={(event) => updateDeedEntry(index, "municipality", event.target.value)} placeholder="Selecciona o escribe otro municipio" maxLength="120" required /></label>
              <label>No. de Exp. Catastral<input value={entry.cadastral_file_number} onChange={(event) => updateDeedEntry(index, "cadastral_file_number", event.target.value)} maxLength="120" required /></label>
            </div>
            {deedEntries.length > 1 && <button type="button" className="secondary remove-deed-entry" onClick={() => setDeedEntries((current) => current.filter((_, entryIndex) => entryIndex !== index))}>Quitar este grupo</button>}
          </fieldset>)}
          <button type="button" className="secondary" onClick={() => setDeedEntries((current) => [...current, emptyDeedEntry()])}>+ Agregar otro folio, municipio y expediente catastral</button>
        </div>}
        <datalist id="municipality-options">{municipalities.map((item) => <option key={item.id} value={item.name} />)}</datalist>
        {documentType === "OTROS" ? <label>Dependencia manual<input list="agency-options" value={agency} onChange={(event) => setAgency(event.target.value)} placeholder="Escribe o selecciona dependencia" required /></label> : <label>Dependencia automática<select value={agency} onChange={(event) => setAgency(event.target.value)} required disabled={Boolean(DOCUMENT_AGENCY_MAP[documentType.toLocaleUpperCase("es-MX")])}><option value="">Seleccionar dependencia</option>{availableAgencies.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>}
        <datalist id="agency-options">{availableAgencies.map((name) => <option key={name} value={name} />)}</datalist>
        <button type="submit" disabled={busy}>{busy ? "Guardando…" : "Agregar documento"}</button>
        </fieldset>
      </form>
      )} />
      </div>
      {lastCreatedDocument && !lastCreatedDocument.archived_at && <section className="panel recent-qr" aria-label="Último documento guardado">
        <div><p className="eyebrow">DOCUMENTO GUARDADO</p><strong>{lastCreatedDocument.case_files.number} · {formatDocumentName(lastCreatedDocument)}</strong><p>Puedes abrir e imprimir su QR desde aquí.</p></div>
        <button onClick={() => showQr(lastCreatedDocument)} disabled={Boolean(qrTask)}>Ver e imprimir QR</button>
      </section>}
      </>}
      {message && message.scope !== "caseCreation" && <div role="status" aria-live="polite" className={`notice page-notice ${message.type}`}>{message.text}</div>}
      {pendingSave && <div className="page-notice"><button className="secondary" onClick={verifyPendingSave} disabled={busy}>{busy ? "Verificando…" : "Verificar guardado"}</button></div>}
      {pendingCreation && <div className="page-notice"><button className="secondary" onClick={verifyDocumentCreation} disabled={busy}>{busy ? "Verificando…" : "Verificar alta"}</button></div>}
      {activeView !== "alta" && caseFeedback}
      {qrTask && <p className="page-notice" aria-live="polite">Preparando QR: {qrTask.done} de {qrTask.total}.</p>}

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
              {isIsaiDocument(document) ? <span>ISAI no requiere número de boleta.</span> : <label>Número de boleta<input value={receiptDrafts[document.id] ?? ""} disabled={documentSaveBlocked} onChange={(event) => setReceiptDrafts((current) => ({ ...current, [document.id]: event.target.value }))} placeholder="Ejemplo: B-12345" maxLength="100" /></label>}
              <button onClick={() => registerReceiptSend(document)} disabled={documentSaveBlocked}>{isIsaiDocument(document) ? "Marcar ENVIADO sin boleta" : "Marcar ENVIADO"}</button>
            </article>
          ))}
        </div>}
      </section>}
      {activeView === "escanear" && <section className="scanner-section standalone">
        <div className="scanner-heading"><div><p className="eyebrow">OPERACIÓN RÁPIDA</p><h2>Escanear varios documentos</h2></div><span>Selecciona una operación una sola vez y escanea todos los documentos</span></div>
        <div className="scan-modes" aria-label="Operación automática al escanear">
          {[["ENVIADO", "ENVIADO"], ["AUTORIZADO", "AUTORIZADO"], ["RECHAZADO", "RECHAZADO"]].map(([status, label]) => (
            <button className={scanMode === status ? "active" : ""} key={status} onClick={() => activateScanMode(status)} disabled={documentSaveBlocked}>{label}</button>
          ))}
        </div>
        <p className="scan-mode-help">{scanMode ? `Modo activo: ${formatStatus(scanMode)}. Cada lectura se guardará automáticamente.` : "Sin modo automático: escanea un documento y después elige la acción."}</p>
        <p className="scan-mode-help">Si eliges ENVIADO y el documento ya tuvo un envío anterior, RASTREADOC lo registrará automáticamente como REINGRESADO.</p>
        {scanMode === "ENVIADO" && <div className="quick-rejection"><label>Número de boleta (excepto ISAI)<input value={receiptNumber} disabled={documentSaveBlocked} onChange={(event) => setReceiptNumber(event.target.value)} placeholder="Captura la boleta de este documento" maxLength="100" /></label><label>Observaciones (opcional)<input value={movementNotes} disabled={documentSaveBlocked} onChange={(event) => setMovementNotes(event.target.value)} /></label></div>}
        {scanMode === "RECHAZADO" && <div className="quick-rejection"><label>Motivo para estos rechazos (opcional)<input value={rejectionReason} disabled={documentSaveBlocked} onChange={(event) => setRejectionReason(event.target.value)} maxLength="250" /></label><label>Observaciones (opcional)<input value={movementNotes} disabled={documentSaveBlocked} onChange={(event) => setMovementNotes(event.target.value)} /></label></div>}
        <form className="scan-form" onSubmit={scanDocument}>
          <input ref={scanInputRef} value={scanToken} onChange={(event) => setScanToken(event.target.value)} placeholder="Escanea el QR aquí" aria-label="Código QR" disabled={documentSaveBlocked} />
          <button type="submit" disabled={documentSaveBlocked}>{busy || processingScan ? "Procesando…" : scanMode ? "Registrar lectura" : "Buscar documento"}</button>
        </form>
        <p className="scan-mode-help">Espera la confirmación en pantalla antes de escanear el siguiente documento.</p>
        {scannedDocument && (
          <div className="scan-result">
            <div className="document-summary">
              <div><span>Expediente</span><strong>{scannedDocument.case_files.number}</strong></div>
              <div><span>Documento</span><strong>{formatDocumentName(scannedDocument)}</strong></div>
              <div><span>Dependencia</span><strong>{scannedDocument.agencies.name}</strong></div>
              <div><span>Estatus actual</span><strong className="status-pill">{formatStatus(scannedDocument.status)}</strong></div>
              <div><span>Último movimiento</span><strong>{formatOfficeDateTime(scannedDocument.last_movement_at)}</strong></div>
              {isOutsideOffice(scannedDocument.status) && <div><span>Tiempo fuera</span><strong>{formatTimeOutside(scannedDocument.last_movement_at, currentTime)}</strong></div>}
            </div>
            {!scanMode && <div className="movement-fields">
              {!isIsaiDocument(scannedDocument) && <label>Número de boleta (solo para enviar)<input value={receiptNumber} disabled={documentSaveBlocked} onChange={(event) => setReceiptNumber(event.target.value)} maxLength="100" /></label>}
              <label>Motivo del rechazo (opcional)<input value={rejectionReason} disabled={documentSaveBlocked} onChange={(event) => setRejectionReason(event.target.value)} maxLength="250" /></label>
              <label>Observaciones (opcional)<input value={movementNotes} disabled={documentSaveBlocked} onChange={(event) => setMovementNotes(event.target.value)} /></label>
            </div>}
            {!scanMode && <div className="movement-actions">
              <button onClick={() => registerMovement("ENVIADO")} disabled={documentSaveBlocked}>Enviar</button>
              <button onClick={() => registerMovement("EN_OFICINA")} disabled={documentSaveBlocked}>Recibir en oficina</button>
              <button onClick={() => registerMovement("AUTORIZADO")} disabled={documentSaveBlocked}>Autorizar</button>
              <button className="danger-button" onClick={() => registerMovement("RECHAZADO")} disabled={documentSaveBlocked}>Rechazar</button>
            </div>}
            {scanMode && manualMovementReady && <button className="quick-register" onClick={() => registerMovement(scanMode)} disabled={documentSaveBlocked}>Registrar {formatStatus(scanMode)}</button>}
          </div>
        )}
      </section>}
      {activeView === "consulta" && <section className="documents-section standalone">
        <div className="documents-heading"><div><p className="eyebrow">CONSULTA</p><h2>Todos los documentos</h2></div><button className="secondary" onClick={printSelectedQrLabels} disabled={Boolean(qrTask)}>Imprimir QR seleccionados ({selectedQrIds.length})</button></div>
        <div className="document-filters">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar expediente, documento o dependencia" aria-label="Buscar documentos" />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filtrar por estatus">
            <option value="">Todos los estatus</option>
            {statusCards.map(([status, label]) => <option value={status} key={status}>{label}</option>)}
          </select>
          <select value={searchDaySort} onChange={(event) => setSearchDaySort(event.target.value)} aria-label="Ordenar por días en estatus">
            <option value="">Orden original</option>
            <option value="desc">Más días primero</option>
            <option value="asc">Menos días primero</option>
          </select>
        </div>
        {filteredDocuments.length === 0 ? <p className="empty-state">No hay documentos que coincidan con la búsqueda.</p> : (
          <div className="documents-list">
            {filteredDocuments.map((document) => (
              <article className="document-row" key={document.id}>
                <div className="document-row-main">{document.status === "EN_OFICINA" && <label className="qr-select"><input type="checkbox" checked={selectedQrIds.includes(document.id)} onChange={() => toggleQrSelection(document.id)} /> QR</label>}<div><strong>{document.case_files.number} · {formatDocumentName(document)}</strong><span>{document.agencies.name} — {formatStatus(document.status)}</span>{["EN_OFICINA", "RECHAZADO", "ENVIADO", "REENVIADO"].includes(document.status) && <span className="time-outside">{statusTimeLabel(document.status)}: {formatTimeOutside(document.last_movement_at, currentTime)}</span>}</div></div>
                <div className="row-actions"><button onClick={() => setCasePreview(document.case_files.number)}>Ver expediente</button>{canOperate && document.status === "RECHAZADO" && <button onClick={() => markRejectedDocumentReady(document)} disabled={documentSaveBlocked}>Listo para enviar</button>}{canOperate && document.status !== "RECHAZADO" && <button onClick={() => prepareSend(document)}>Registrar envío</button>}{canManageAll && <button className="secondary" onClick={() => prepareCorrection(document)}>Editar</button>}<button className="secondary" onClick={() => showHistory(document)} disabled={busy}>Historial</button><button className="secondary" onClick={() => showQr(document)}>Ver QR</button>{canManageAll && <button className="archive-button" onClick={() => archiveDocument(document)}>Archivar</button>}</div>
              </article>
            ))}
          </div>
        )}
      </section>}
      {activeView === "reportes" && <section className="reports-section">
        <div className="reports-heading"><div><p className="eyebrow">DOCUMENTOS ACTUALES</p><h2>Reporte por fecha y tipo de documento</h2></div><strong>{reportRangeError ? "Revisa las fechas" : `${filteredReportDocuments.length} documentos`}</strong></div>
        <p className="report-timezone">Fechas y horas de la Ciudad de México.</p>
        <div className="report-actions"><button onClick={() => openPrintableReport(true)} disabled={Boolean(reportRangeError)}>Imprimir</button><button className="secondary" onClick={exportReportToExcel} disabled={Boolean(reportRangeError)}>Exportar a Excel</button><button className="secondary" onClick={() => openPrintableReport(false)} disabled={Boolean(reportRangeError)}>Ver PDF</button></div>
        {reportRangeError && <p role="alert" className="notice error">{reportRangeError}</p>}
        <div className="report-filters">
          <label>Seguimiento<select value={reportAlert} onChange={(event) => setReportAlert(event.target.value)}><option value="">Todos los documentos</option><option value="SENT_OVERDUE">Enviados vencidos</option><option value="REJECTED_OVERDUE">Rechazados vencidos</option></select></label>
          <label>Expediente<input list="report-case-files" value={reportCase} onChange={(event) => setReportCase(event.target.value)} placeholder="Escribe parte del número" /></label>
          <datalist id="report-case-files">{caseFiles.map((caseFile) => <option key={caseFile.id} value={caseFile.number} />)}</datalist>
          <label>Desde<input type="date" value={reportStart} onChange={(event) => setReportStart(event.target.value)} /></label>
          <label>Hasta<input type="date" value={reportEnd} onChange={(event) => setReportEnd(event.target.value)} /></label>
          <label>Estatus<select value={reportStatus} onChange={(event) => setReportStatus(event.target.value)}><option value="">Todos</option>{statusCards.map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label>
          <label>Tipo de documento<select value={reportType} onChange={(event) => setReportType(event.target.value)}><option value="">Todos</option>{availableDocumentTypes.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
          <label>Abogado<select value={reportLawyer} onChange={(event) => setReportLawyer(event.target.value)}><option value="">Todos</option>{lawyers.map((lawyer) => <option key={lawyer.id} value={lawyer.id}>{lawyer.name}</option>)}</select></label>
          <label>Auxiliar<select value={reportAuxiliary} onChange={(event) => setReportAuxiliary(event.target.value)}><option value="">Todos</option>{auxiliaries.map((auxiliaryRecord) => <option key={auxiliaryRecord.id} value={auxiliaryRecord.id}>{auxiliaryRecord.name}</option>)}</select></label>
          <label>Ordenar por días<select value={reportDaySort} onChange={(event) => setReportDaySort(event.target.value)}><option value="">Orden original</option><option value="desc">Más días primero</option><option value="asc">Menos días primero</option></select></label>
        </div>
        <div className="report-table-wrap"><table className="report-table"><thead><tr><th>Último movimiento</th><th>Días en estatus</th><th>Expediente</th><th>Auxiliar</th><th>Documento</th><th>Folio forma</th><th>Municipio</th><th>No. de Exp. Catastral</th><th>Abogado</th><th>Dependencia</th><th>Estatus actual</th><th>Número de boleta</th></tr></thead><tbody>
          {filteredReportDocuments.map((movement) => <tr key={movement.id}><td>{movement.date_label}</td><td><strong>{elapsedDays(movement.occurred_at, currentTime)}</strong></td><td>{movement.documents?.case_files?.number}</td><td>{movement.documents?.auxiliaries?.name || "—"}</td><td>{movement.documents ? formatDocumentName(movement.documents) : ""}</td><td>{deedColumn(movement.documents, "folio_forma") || "—"}</td><td>{deedColumn(movement.documents, "municipality") || "—"}</td><td>{deedColumn(movement.documents, "cadastral_file_number") || "—"}</td><td>{movement.documents?.lawyers?.name || "—"}</td><td>{movement.documents?.agencies?.name}</td><td><strong>{formatStatus(movement.documents?.status)}</strong></td><td>{movement.receipt_number || "—"}</td></tr>)}
          {filteredReportDocuments.length === 0 && <tr><td colSpan="12">{reportRangeError ? "Revisa el rango de fechas." : "No hay documentos que coincidan con estos filtros."}</td></tr>}
        </tbody></table></div>
      </section>}

      {activeView === "catalogos" && <section className="catalogs-section standalone">
        <div className="catalogs-heading"><div><p className="eyebrow">CATÁLOGOS</p><h2>Datos de captura</h2><p>Administra tipos, dependencias, abogados, auxiliares y municipios desde un solo lugar.</p></div></div>
        <div className="catalogs-grid">
          <form className="catalog-card" onSubmit={(event) => addCatalogItem(event, "document_types", newDocumentTypeName, setNewDocumentTypeName, setDocumentTypes, "Tipo de documento")}>
            <h3>Tipos de documento</h3>
            <label>Nuevo tipo<input value={newDocumentTypeName} onChange={(event) => setNewDocumentTypeName(event.target.value)} placeholder="Ejemplo: PODER" /></label>
            <button type="submit" disabled={busy}>Agregar tipo</button>
            <div className="catalog-tags">{availableDocumentTypes.map((name) => {
              const record = documentTypes.find((item) => item.name.toLocaleUpperCase("es-MX") === name.toLocaleUpperCase("es-MX"));
              const isDefault = DEFAULT_DOCUMENT_TYPES.includes(name.toLocaleUpperCase("es-MX"));
              return <span key={name}>{name}{record && !isDefault && canManageAll && <button type="button" className="catalog-delete" onClick={() => deleteCatalogItem("document_types", record, setDocumentTypes, "Tipo de documento")} disabled={busy} aria-label={`Eliminar ${name}`}>×</button>}</span>;
            })}</div>
          </form>
          <form className="catalog-card" onSubmit={(event) => addCatalogItem(event, "agencies", newAgencyName, setNewAgencyName, setAgencies, "Dependencia")}>
            <h3>Dependencias</h3>
            <label>Nueva dependencia<input value={newAgencyName} onChange={(event) => setNewAgencyName(event.target.value)} placeholder="Ejemplo: SECRETARÍA" /></label>
            <button type="submit" disabled={busy}>Agregar dependencia</button>
            <div className="catalog-tags">
              {agencies.map((record) => <span className={isObsoleteAgencyName(record.name) ? "catalog-invalid" : ""} key={record.id}>{record.name}{canManageAll && <button type="button" className="catalog-delete" onClick={() => deleteCatalogItem("agencies", record, setAgencies, "Dependencia")} disabled={busy} aria-label={`Eliminar ${record.name}`}>×</button>}</span>)}
              {DEFAULT_AGENCIES.filter((name) => !agencies.some((record) => record.name.toLocaleUpperCase("es-MX") === name.toLocaleUpperCase("es-MX"))).map((name) => <span key={name}>{name}</span>)}
            </div>
          </form>
          <form className="catalog-card" onSubmit={(event) => addCatalogItem(event, "lawyers", newLawyerName, setNewLawyerName, setLawyers, "Abogado")}>
            <h3>Abogados</h3>
            <label>Nombre del abogado<input value={newLawyerName} onChange={(event) => setNewLawyerName(event.target.value)} placeholder="Ejemplo: LIC. ANA PÉREZ" required /></label>
            <button type="submit" disabled={busy}>Agregar abogado</button>
            <div className="catalog-tags">{lawyers.map((record) => <span key={record.id}>{record.name}{canManageAll && <button type="button" className="catalog-delete" onClick={() => deleteCatalogItem("lawyers", record, setLawyers, "Abogado")} disabled={busy} aria-label={`Eliminar ${record.name}`}>×</button>}</span>)}</div>
          </form>
          <form className="catalog-card" onSubmit={(event) => addCatalogItem(event, "auxiliaries", newAuxiliaryName, setNewAuxiliaryName, setAuxiliaries, "Auxiliar")}>
            <h3>Auxiliares</h3>
            <label>Nombre del auxiliar<input value={newAuxiliaryName} onChange={(event) => setNewAuxiliaryName(event.target.value)} placeholder="Ejemplo: MARÍA LÓPEZ" required /></label>
            <button type="submit" disabled={busy}>Agregar auxiliar</button>
            <div className="catalog-tags">{auxiliaries.map((record) => <span key={record.id}>{record.name}{canManageAll && <button type="button" className="catalog-delete" onClick={() => deleteCatalogItem("auxiliaries", record, setAuxiliaries, "Auxiliar")} disabled={busy} aria-label={`Eliminar ${record.name}`}>×</button>}</span>)}</div>
          </form>
          <form className="catalog-card" onSubmit={(event) => addCatalogItem(event, "municipalities", newMunicipalityName, setNewMunicipalityName, setMunicipalities, "Municipio")}>
            <h3>Municipios</h3>
            <label>Nuevo municipio<input value={newMunicipalityName} onChange={(event) => setNewMunicipalityName(event.target.value)} placeholder="Escribe un municipio adicional" required /></label>
            <button type="submit" disabled={busy}>Agregar municipio</button>
            <div className="catalog-tags">{municipalities.map((record) => <span key={record.id}>{record.name}{canManageAll && <button type="button" className="catalog-delete" onClick={() => deleteCatalogItem("municipalities", record, setMunicipalities, "Municipio")} disabled={busy} aria-label={`Eliminar ${record.name}`}>×</button>}</span>)}</div>
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
          {archivedDocuments.map((document) => <article className="document-row archived-row" key={document.id}><div><strong>{document.case_files.number} · {formatDocumentName(document)}</strong><span>{document.agencies.name} — {formatStatus(document.status)}</span><span>Archivado: {formatOfficeDateTime(document.archived_at)}</span></div><div className="row-actions"><button onClick={() => restoreDocument(document)} disabled={busy}>Restaurar</button><button className="secondary" onClick={() => showHistory(document)} disabled={busy}>Historial</button></div></article>)}
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
                    <strong>{formatOfficeDateTime(document.last_movement_at)}</strong>
                    {isOutsideOffice(document.status) && <small className="time-outside">Fuera: {formatTimeOutside(document.last_movement_at, currentTime)}</small>}
                  </div>
                  <div className="case-document-actions">{canOperate && document.status === "RECHAZADO" && <button onClick={() => { setCasePreview(null); markRejectedDocumentReady(document); }}>Listo para enviar</button>}{canOperate && document.status !== "RECHAZADO" && <button onClick={() => { setCasePreview(null); prepareSend(document); }}>Registrar envío</button>}{canManageAll && <button className="secondary" onClick={() => { setCasePreview(null); prepareCorrection(document); }}>Editar</button>}<button className="secondary" onClick={() => { setCasePreview(null); showHistory(document); }}>Historial</button><button className="secondary" onClick={() => { setCasePreview(null); showQr(document); }}>QR</button></div>
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
            {qrPreview.dataUrl ? <img src={qrPreview.dataUrl} alt={`QR del expediente ${qrPreview.document.case_files.number}`} /> : qrPreview.error ? <><p role="alert">No fue posible generar el QR. El documento sigue guardado.</p><button onClick={() => showQr(qrPreview.document)}>Volver a generar QR</button></> : <p aria-live="polite">Preparando QR…</p>}
            {qrPreview.printError && <p role="alert">{qrPreview.printError}</p>}
            <button onClick={printQr} disabled={!qrPreview.dataUrl || Boolean(qrTask)}>Imprimir etiqueta 40 × 30 mm</button>
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
                <li key={movement.id}><span>{formatOfficeDateTime(movement.occurred_at)}</span><strong>{formatStatus(movement.status)}</strong>{movement.receipt_number && <p><b>Boleta:</b> {movement.receipt_number}</p>}{movement.rejection_reason && <p><b>Motivo:</b> {movement.rejection_reason}</p>}{movement.notes && <p><b>Observaciones:</b> {movement.notes}</p>}</li>
              ))}
            </ol>
          </section>
        </div>
      )}
      {editPreview && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Editar documento">
          <form className="edit-modal" onSubmit={saveStatusCorrection}>
            <button type="button" className="modal-close" onClick={() => setEditPreview(null)} aria-label="Cerrar">×</button>
            <p className="eyebrow">CORRECCIÓN</p>
            <h2>Editar documento</h2>
            <p>{editPreview.case_files.number} · {formatDocumentName(editPreview)}</p>
            <div className="status-change-preview"><span>Actual</span><strong>{formatStatus(editPreview.status)}</strong><span>Nuevo</span><strong>{formatStatus(correctedStatus)}</strong></div>
            <label>Identificador para distinguirlo (opcional)<input value={correctedDocumentLabel} disabled={documentSaveBlocked} onChange={(event) => setCorrectedDocumentLabel(event.target.value)} placeholder="Ejemplo: Original, Copia 1, Segundo certificado" maxLength="120" /></label>
            <label>Estatus correcto<select value={correctedStatus} disabled={documentSaveBlocked} onChange={(event) => setCorrectedStatus(event.target.value)}>{statusCards.map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label>
            <label>Motivo de la corrección (opcional)<input value={correctionNote} disabled={documentSaveBlocked} onChange={(event) => setCorrectionNote(event.target.value)} placeholder="Ejemplo: Se seleccionó rechazado por error" /></label>
            {message && <div className={`notice ${message.type}`} role="status" aria-live="polite">{message.text}</div>}
            {pendingSave && <button type="button" className="secondary" onClick={verifyPendingSave} disabled={busy}>Verificar guardado</button>}
            <div className="edit-actions"><button type="button" className="secondary" disabled={busy} onClick={() => { if (!operationClient.isInFlight()) setEditPreview(null); }}>Cancelar</button><button type="submit" disabled={documentSaveBlocked}>Guardar cambios</button></div>
            <small>Si cambias el estatus, el movimiento anterior permanecerá en el historial.</small>
          </form>
        </div>
      )}
    </main>
  );
}
