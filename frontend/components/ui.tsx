"use client";

import type {ButtonHTMLAttributes, ReactNode} from "react";

/* Small shared primitives for the ArrowHead console. Kept dependency-free
 * by design — the whole design system lives in globals.css as CSS variables,
 * so components just compose tokens. */

/** Icon buttons / inline icons — a minimal hand-rolled pack so the console
 * doesn't ship an icon dependency for the ~10 glyphs it actually needs. */
export function Icon({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const p = {width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className, "aria-hidden": true};
  switch (name) {
    case "arrow-up":
      return (<svg {...p}><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>);
    case "sun":
      return (<svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>);
    case "moon":
      return (<svg {...p}><path d="M20.4 14.2A8 8 0 0 1 9.8 3.6 8 8 0 1 0 20.4 14.2Z" /></svg>);
    case "bolt":
      return (<svg {...p}><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" /></svg>);
    case "shield":
      return (<svg {...p}><path d="M12 22s8-3.6 8-10V5l-8-3-8 3v7c0 6.4 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></svg>);
    case "activity":
      return (<svg {...p}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>);
    case "table":
      return (<svg {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></svg>);
    case "layers":
      return (<svg {...p}><path d="m12 2 9 4.9-9 4.9-9-4.9L12 2Z" /><path d="m3 12.9 9 4.9 9-4.9" /><path d="m3 17.8 9 4.9 9-4.9" /></svg>);
    case "pie":
      return (<svg {...p}><path d="M21.2 15.9A10 10 0 1 1 8.1 2.7" /><path d="M22 12A10 10 0 0 0 12 2v10h10Z" /></svg>);
    case "refresh":
      return (<svg {...p}><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></svg>);
    case "plus":
      return (<svg {...p}><path d="M12 5v14M5 12h14" /></svg>);
    case "close":
      return (<svg {...p}><path d="M18 6 6 18M6 6l12 12" /></svg>);
    case "check":
      return (<svg {...p}><path d="m5 12 5 5 9-11" /></svg>);
    case "alert":
      return (<svg {...p}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg>);
    case "wallet":
      return (<svg {...p}><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><path d="M18 12a2 2 0 0 0 0 4h4v-4h-4Z" /></svg>);
    case "send":
      return (<svg {...p}><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="M22 2 11 13" /></svg>);
    case "swap":
      return (<svg {...p}><path d="M7 16V4M7 4 3 8M7 4l4 4M17 8v12M17 20l4-4M17 20l-4-4" /></svg>);
    case "menu":
      return (<svg {...p}><path d="M4 6h16M4 12h16M4 18h16" /></svg>);
    default:
      return null;
  }
}

/** Primary/secondary button with tone + size variants. */
export function Button({
  children,
  variant = "secondary",
  tone,
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  tone?: "accent" | "success" | "danger" | "default";
  size?: "sm" | "md";
}) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-[10px] font-semibold transition-colors disabled:opacity-45 disabled:cursor-not-allowed select-none";
  const sizes = size === "sm" ? "text-[12px] px-2.5 py-1.5" : "text-[13px] px-3.5 py-2";
  const tones: Record<string, string> = {
    default: "",
    accent: "!text-[var(--accent)] !border-[var(--accent)] hover:!bg-[var(--accent-soft)]",
    success: "!text-[var(--success)] !border-[var(--success)] hover:!bg-[var(--success-soft)]",
    danger: "!text-[var(--danger)] !border-[var(--danger)] hover:!bg-[var(--danger-soft)]",
  };
  const variants: Record<string, string> = {
    primary: "text-white bg-[var(--accent)] border border-transparent hover:bg-[var(--accent-strong)]",
    secondary: "bg-[var(--panel-2)] border border-[var(--line)] text-[var(--text)] hover:border-[var(--muted)]",
    ghost: "bg-transparent border border-transparent text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel-2)]",
  };
  return (
    <button className={`${base} ${sizes} ${variants[variant]} ${tones[tone ?? "default"]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function Card({children, className = "", style}: {children: ReactNode; className?: string; style?: React.CSSProperties}) {
  return <div className={`panel ${className}`} style={style}>{children}</div>;
}

/** Compact KPI tile: label over a big value, optional caption + tone. */
export function Stat({
  label,
  value,
  sub,
  tone,
  icon,
  live,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "pos" | "neg" | "accent" | "warn";
  icon?: string;
  live?: boolean;
}) {
  const toneClass =
    tone === "pos" ? "text-[var(--success)]" : tone === "neg" ? "text-[var(--danger)]" : tone === "warn" ? "text-[var(--warn)]" : "text-[var(--text)]";
  return (
    <div className="panel p-4 min-w-0">
      <div className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">
        <span className="truncate">{label}</span>
        <span className="flex-none">
          {icon && <Icon name={icon} size={14} className={live ? "live" : ""} />}
        </span>
      </div>
      <div className={`mt-1.5 text-[22px] font-bold leading-tight tabular-nums ${toneClass} truncate`} title={typeof value === "string" ? value : undefined}>
        {value}
      </div>
      {sub != null && <div className="mt-1 text-[11.5px] text-[var(--muted)] truncate">{sub}</div>}
    </div>
  );
}

/** Status pill with a dot. `tone` drives the color; `soft` renders a badge on
 * the neutral surface (for "secondary" states). */
export function Pill({children, tone = "neutral", soft, title}: {children: ReactNode; tone?: "pos" | "neg" | "warn" | "accent" | "neutral" | "info"; soft?: boolean; title?: string}) {
  const color =
    tone === "pos" ? "var(--success)" : tone === "neg" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : tone === "accent" ? "var(--accent)" : tone === "info" ? "var(--info)" : "var(--muted)";
  const bg =
    tone === "pos" ? "var(--success-soft)" : tone === "neg" ? "var(--danger-soft)" : tone === "warn" ? "var(--warn-soft)" : tone === "accent" ? "var(--accent-soft)" : tone === "info" ? "var(--info-soft)" : "var(--panel-2)";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em]" style={{color, background: soft ? bg : "transparent", borderColor: "currentColor"}} title={title}>
      {children}
    </span>
  );
}

/** Section title bar used at the top of each dashboard block. */
export function SectionTitle({id, title, subtitle, right, onToggle, open, defaultBadge}: {id: string; title: ReactNode; subtitle?: ReactNode; right?: ReactNode; onToggle?: () => void; open?: boolean; defaultBadge?: ReactNode}) {
  return (
    <div id={id} className="flex items-center gap-3 flex-wrap" style={{scrollMarginTop: 8}}>
      <div className="flex items-center gap-2.5 flex-1 min-w-0">
        <span className="h-4 w-1.5 rounded-full bg-[var(--accent)] flex-none" aria-hidden />
        <h2 className="text-[15px] font-bold tracking-tight truncate">{title}</h2>
        {subtitle && <span className="hidden md:inline text-[12px] text-[var(--muted)] truncate">{subtitle}</span>}
      </div>
      <div className="flex items-center gap-2 shrink-0">{right}</div>
    </div>
  );
}

export function Toggle({checked, onChange, label, disabled, tone = "accent"}: {checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean; tone?: "accent" | "success" | "danger"}) {
  const on = tone === "danger" ? "var(--danger)" : tone === "success" ? "var(--success)" : "var(--accent)";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center rounded-full border border-[var(--line)] bg-[var(--panel-2)] px-2 py-0.5 gap-1.5 disabled:opacity-50"
    >
      <span className="relative h-4 w-7 flex-none rounded-full transition-colors" style={{background: checked ? on : "var(--line)"}}>
        <span className="absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform" style={{transform: checked ? "translateX(14px)" : "translateX(2px)"}} />
      </span>
      {label && <span className="text-[12px] font-semibold">{label}</span>}
    </button>
  );
}

export function Field({label, hint, children}: {label: string; hint?: string; children: ReactNode}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--muted)]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-[var(--muted)]">{hint}</span>}
    </label>
  );
}

export function EmptyState({children}: {children: ReactNode}) {
  return <div className="px-4 py-10 text-center text-[13px] text-[var(--muted)]">{children}</div>;
}