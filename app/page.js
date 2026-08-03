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
    const { error } = await supabase.from("case_files").insert({ number: cleanNumber });
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
    setMessage({ type: "success", text: `Expediente ${cleanNumber} guardado correctamente.` });
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
      <form className="panel case-panel" onSubmit={createCaseFile}>
        <div>
          <h2>Nuevo expediente</h2>
          <p>Escribe el número exactamente como aparece en tu otro programa.</p>
        </div>
        <label>Número de expediente<input value={number} onChange={(event) => setNumber(event.target.value)} placeholder="Ejemplo: 2548/2026" autoFocus required /></label>
        {message && <div className={`notice ${message.type}`}>{message.text}</div>}
        <button type="submit" disabled={busy}>{busy ? "Guardando…" : "Guardar expediente"}</button>
      </form>
    </main>
  );
}
