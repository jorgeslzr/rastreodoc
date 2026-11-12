import "./globals.css";
import "./redesign.css";

export const metadata = {
  title: "RASTREADOC",
  description: "Control y rastreo de documentos y expedientes",
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
