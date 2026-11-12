const paths = {
  home: "m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9",
  plus: "M12 4v16M4 12h16",
  ticket: "M4 5h16v5a2 2 0 0 0 0 4v5H4v-5a2 2 0 0 0 0-4V5Zm8 3v1m0 3v1m0 3v1",
  scan: "M8 3H4a1 1 0 0 0-1 1v4m13-5h4a1 1 0 0 1 1 1v4M3 16v4a1 1 0 0 0 1 1h4m8 0h4a1 1 0 0 0 1-1v-4M5 12h14",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  chart: "M4 12h3v9H4v-9Zm7-8h3v17h-3V4Zm7 4h3v13h-3V8Z",
  archive: "M3 4h18v5H3V4Zm2 5v12h14V9M9 13h6",
  layers: "m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  document: "M14 2H5a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8l-6-6Zm0 0v6h6M8 12h8m-8 4h6",
  check: "m7 12 3 3 7-7M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  clock: "M12 6v6l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  print: "M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6v-7Zm12-2h.01",
  spreadsheet: "M14 2H5v20h15V8l-6-6Zm0 0v6h6M8 12h9M8 16h9M8 20h9m-5-8v8",
  pdf: "M14 2H5v20h15V8l-6-6Zm0 0v6h6M8 12h8m-8 4h8m-8 3h5",
  send: "m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13",
  edit: "m16 3 5 5-12 12-6 1 1-6L16 3Zm-2 2 5 5",
  history: "M3 11a9 9 0 1 1 2.7 7M3 4v7h7m2-5v6l4 2",
  qr: "M3 3h6v6H3V3Zm12 0h6v6h-6V3ZM3 15h6v6H3v-6Zm12 0h2v2h-2v-2Zm4 4h2v2h-2v-2Zm-4 2v-2m6-4h-2M12 3v3m0 5v3M3 12h3m4 0h1m4 0h6M12 18v3",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4M12 2V1",
  user: "M16 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM5 20a7 7 0 0 1 14 0M23 12a11 11 0 1 1-22 0 11 11 0 0 1 22 0Z",
  logout: "M9 3H3v18h6m6-16 7 7-7 7M7 12h15",
  menu: "M3 6h18M3 12h18M3 18h18",
  close: "m6 6 12 12M6 18 18 6",
};

export default function Icon({ name, className = "" }) {
  return <svg className={`ui-icon ${className}`} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={paths[name] || paths.document} />
  </svg>;
}

export function ActionButton({ icon, children, className = "", ...props }) {
  return <button {...props} className={`action-button ${className}`}>
    <Icon name={icon} />{children}
  </button>;
}
