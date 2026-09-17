"use client";

import {useState, type ReactNode} from "react";
import {Icon} from "./ui";

/** Collapsible dashboard section with a sticky-anchor id for the jump nav
 * and a tone dot for the brand accent. */
export default function Section({
  id,
  icon,
  title,
  subtitle,
  defaultOpen = true,
  right,
  children,
}: {
  id: string;
  icon?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section id={id} className="panel" style={{scrollMarginTop: 8}}>
      <div
        className="panel-head"
        style={{cursor: "pointer", userSelect: "none"}}
        onClick={() => setOpen((o) => !o)}
        title={open ? "collapse section" : "expand section"}
        role="button"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2.5 min-w-0">
          {icon && (
            <Icon
              name={icon}
              size={15}
              className="flex-none"
            />
          )}
          <span className="truncate">{title}</span>
        </span>
        <span className="flex items-center gap-3 shrink-0 min-w-0">
          {right && <span onClick={(e) => e.stopPropagation()}>{right}</span>}
          {subtitle && <span className="muted hidden lg:inline truncate">{subtitle}</span>}
          <span
            className="text-[10px] text-[var(--muted)]"
            style={{transform: open ? "none" : "rotate(-90deg)", transition: "transform 120ms ease"}}
          >
            ▾
          </span>
        </span>
      </div>
      {open && <div className="p-1.5 sm:p-2">{children}</div>}
    </section>
  );
}