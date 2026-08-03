"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

export default function HomePage() {
  const [session, setSession] = useState(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [number, setNumber] = useState("");
  const [caseFiles, setCaseFiles] = useState([]);
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [agency, setAgency] = useState("");
  const [documentTypes, setDocumentTypes] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [message, setMessage] = useState(null);
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
    if (!session) return;

    Promise.all([
      supabase.from("case_files").select("id, number").order("created_at", { ascending: false }),
      supabase.from("document_types").select("id, name").order("name"),
      supabase.from("agencies").select("id, name").order("name"),
    ]).then(([caseResult, typeResult, agencyResult]) => {
      setCaseFiles(caseResult.data ?? []);
      setDocumentTypes(typeResult.data ?? []);
      setAgencies(agencyResult.data ?? []);
    });
  }, [session]);

  async function signIn(event) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);

    if (error) {
      setMessage({ type: "error", text: "Correo o contraseña incorrectos." });
    }
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
    setSelectedCaseId(data.id);
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

  async function createDocument(event) {
    event.preventDefault();
    if (!selectedCaseId || !documentType.trim() || !agency.trim()) return;

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

    const { error } = await supabase.from("documents").insert({
      case_file_id: selectedCaseId,
      document_type_id: typeRecord.id,
      agency_id: agencyRecord.id,
    });
    setBusy(false);

    if (error) {
      setMessage({ type: "error", text: "No fue posible guardar el documento." });
      return;
    }

    setDocumentTypes((current) => current.some(({ id }) => id === typeRecord.id) ? current : [...current, typeRecord]);
    setAgencies((current) => current.some(({ id }) => id === agencyRecord.id) ? current : [...current, agencyRecord]);
    setDocumentType("");
    setAgency("");
    setMessage({ type: "success", text: "Documento agregado con estatus EN OFICINA." });
  }

  if (loadingSession) {
    return <main className="center-shell">Cargando Ratreodoc…</main>;
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
          <label>Correo electrónico<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
          <label>Contraseña<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          {message && <div className={`notice ${message.type}`}>{message.text}</div>}
          <button type="submit" disabled={busy}>{busy ? "Ingresando…" : "Ingresar"}</button>
        </form>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <div className="page-heading">
        <div><p className="eyebrow">EXPEDIENTES</p><h1>Alta de expediente</h1></div>
        <button className="secondary" onClick={() => supabase.auth.signOut()}>Cerrar sesión</button>
      </div>
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
        <div><h2>Agregar documento</h2><p>Elige el expediente y captura los datos del documento.</p></div>
        <label>Expediente
          <select value={selectedCaseId} onChange={(event) => setSelectedCaseId(event.target.value)} required>
            <option value="">Seleccionar expediente</option>
            {caseFiles.map((caseFile) => <option key={caseFile.id} value={caseFile.id}>{caseFile.number}</option>)}
          </select>
        </label>
        <label>Tipo de documento<input list="document-types" value={documentType} onChange={(event) => setDocumentType(event.target.value)} placeholder="Ejemplo: Aviso preventivo" required /></label>
        <datalist id="document-types">{documentTypes.map((item) => <option key={item.id} value={item.name} />)}</datalist>
        <label>Dependencia<input list="agencies" value={agency} onChange={(event) => setAgency(event.target.value)} placeholder="Ejemplo: Registro Público" required /></label>
        <datalist id="agencies">{agencies.map((item) => <option key={item.id} value={item.name} />)}</datalist>
        <button type="submit" disabled={busy}>{busy ? "Guardando…" : "Agregar documento"}</button>
      </form>
      </div>
      {message && <div className={`notice page-notice ${message.type}`}>{message.text}</div>}
    </main>
  );
}
