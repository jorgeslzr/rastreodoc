export default function Brand() {
  return <div className="brand">
    <div className="brand-mark" aria-hidden="true">R</div>
    <div className="brand-copy"><strong>RASTREADOC</strong><span>Control documental</span></div>
  </div>;
}

export function BrandHeader() {
  return <header className="site-header"><Brand /></header>;
}
