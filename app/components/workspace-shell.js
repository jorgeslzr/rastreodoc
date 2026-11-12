"use client";

import { useEffect, useRef, useState } from "react";
import Brand from "./brand";
import Icon, { ActionButton } from "./ui";

const navigationIcons = {
  panel: "home", alta: "plus", boletas: "ticket", escanear: "scan",
  consulta: "search", reportes: "chart", archivados: "archive",
  catalogos: "layers", usuarios: "users",
};

function NavigationItems({ items, activeView, onNavigate }) {
  return items.map(([view, label]) => <button type="button" key={view}
    className={activeView === view ? "active" : ""}
    aria-current={activeView === view ? "page" : undefined}
    onClick={() => onNavigate(view)}>
    <Icon name={navigationIcons[view]} /><span>{label}</span>
  </button>);
}

export default function WorkspaceShell({ children, activeView, title, eyebrow, navigation, onNavigate, username, roleLabel, onSignOut, search, onSearch, summaries, overdueCount }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const sidebar = useRef(null);
  const menuToggle = useRef(null);
  const searchEnabled = activeView === "consulta";

  function closeMenu() {
    setMenuOpen(false);
    menuToggle.current?.focus();
  }

  useEffect(() => {
    if (!menuOpen) return;
    sidebar.current?.querySelector('[aria-current="page"]')?.focus();
    const desktop = window.matchMedia("(min-width: 901px)");
    const resize = () => { if (desktop.matches) setMenuOpen(false); };
    const keydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        menuToggle.current?.focus();
      }
      if (event.key !== "Tab") return;
      const panel = sidebar.current;
      if (!panel) return;
      const buttons = [...panel.querySelectorAll("button:not([disabled])")].filter((button) => button.getClientRects().length);
      const first = buttons[0];
      const last = buttons.at(-1);
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    desktop.addEventListener("change", resize);
    return () => {
      document.removeEventListener("keydown", keydown);
      desktop.removeEventListener("change", resize);
    };
  }, [menuOpen]);

  function navigate(view) {
    setMenuOpen(false);
    onNavigate(view);
  }

  return <div className={`workspace-app${menuOpen ? " menu-open" : ""}`}>
    {menuOpen && <button type="button" className="navigation-scrim" tabIndex={-1} aria-label="Cerrar navegación" onClick={closeMenu} />}
    <aside id="workspace-navigation" className="app-sidebar" ref={sidebar} aria-label="Navegación de RASTREADOC">
      <div className="sidebar-brand"><Brand /><button type="button" className="sidebar-close" onClick={closeMenu} aria-label="Cerrar menú de navegación"><Icon name="close" /></button></div>
      <nav className="main-menu sidebar-navigation" aria-label="Menú principal">
        <NavigationItems items={navigation} activeView={activeView} onNavigate={navigate} />
      </nav>
      <div className="sidebar-caption"><span />Control de expedientes y documentos</div>
    </aside>
    <div className="workspace-main">
      <header className="workspace-topbar">
        <button type="button" className="menu-toggle" ref={menuToggle} aria-label="Abrir menú de navegación" aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen((open) => !open)}><Icon name="menu" /></button>
        <label className={`workspace-search${searchEnabled ? "" : " search-reference"}`}>
          <Icon name="search" /><span className="sr-only">Buscar documentos</span>
          <input aria-label="Buscar documentos" value={searchEnabled ? search : ""} onChange={(event) => onSearch(event.target.value)} disabled={!searchEnabled}
            placeholder={searchEnabled ? "Buscar expediente, documento o dependencia" : "Búsqueda disponible en la sección Buscar"}
            title={searchEnabled ? "Buscar expediente, documento o dependencia" : "Disponible en la sección Buscar"} />
        </label>
        <div className="topbar-account">
          <span className="notification-indicator" role="img" aria-label={overdueCount ? `${overdueCount} documentos con seguimiento vencido` : "Sin documentos con seguimiento vencido"} title="Seguimiento vencido de documentos">
            <Icon name="bell" />{overdueCount > 0 && <span className="notification-count">{overdueCount}</span>}
          </span>
          <div className="session-box workspace-user"><Icon name="user" /><div><strong>{username}</strong><small>{roleLabel}</small></div>
            <ActionButton type="button" icon="logout" className="secondary workspace-signout" aria-label="Cerrar sesión" onClick={onSignOut}><span>Cerrar sesión</span></ActionButton>
          </div>
        </div>
      </header>
      <main className="page-shell" id="workspace-content">
        <div className="page-heading">
          <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>
          <section className="summary-strip" aria-label="Indicadores de documentos">
            {summaries.map((item) => <div className="summary-tile" key={item.label} role="group" aria-label={item.label}>
              <Icon name={item.icon} /><strong className="summary-value">{item.value.toLocaleString("es-MX")}</strong><span>{item.label}</span>
            </div>)}
          </section>
        </div>
        <nav className="section-menu" aria-label="Accesos de sección"><NavigationItems items={navigation} activeView={activeView} onNavigate={navigate} /></nav>
        {children}
      </main>
    </div>
  </div>;
}
