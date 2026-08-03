export default function HomePage() {
  return (
    <main className="page-shell">
      <p className="eyebrow">SISTEMA NOTARIAL</p>
      <h1>Control de documentos</h1>
      <p className="intro">
        La aplicación ya está preparada para conectarse con Supabase y publicarse en Vercel.
      </p>
      <section className="status-card">
        <div className="status-icon">✓</div>
        <div>
          <h2>Base de la aplicación lista</h2>
          <p>El siguiente paso será conectar de forma segura la base de datos.</p>
        </div>
      </section>
    </main>
  );
}
