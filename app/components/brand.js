import Image from "next/image";

const logo = "/brand/rastreadoc-logo.png";

export default function Brand({ compact = false }) {
  return <div className={`brand${compact ? " brand--compact" : ""}`} role="img" aria-label="RASTREADOC — Control documental">
    <span className="brand-mark" aria-hidden="true"><Image src={logo} alt="" width={2172} height={724} sizes="240px" loading="eager" /></span>
    {!compact && <span className="brand-lockup" aria-hidden="true"><Image src={logo} alt="" width={2172} height={724} sizes="(min-width:1600px) 280px, 240px" loading="eager" /></span>}
  </div>;
}

export function BrandHeader() {
  return <header className="site-header"><Brand /></header>;
}
