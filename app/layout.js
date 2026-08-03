import "./globals.css";

export const metadata = {
  title: "Ratreodoc",
  description: "Control y rastreo de documentos y expedientes",
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>
        <header className="site-header">
          <div className="brand-mark">R</div>
          <div>
            <strong>Ratreodoc</strong>
            <span>Control documental</span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
