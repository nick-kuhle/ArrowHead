"use client";

import {useEffect, useState} from "react";
import {Icon} from "./ui";

export type ThemePref = "light" | "dark" | "auto";

const KEY = "ah-theme";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "auto") return v;
  } catch {
    /* ignore */
  }
  return "auto";
}

function apply(pref: ThemePref) {
  const el = document.documentElement;
  if (pref === "auto") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", pref);
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
}

/** Sun / auto / moon segmented control. "auto" follows the OS and is the
 * default; the inline boot script in layout.tsx applies the stored pref
 * before first paint so there is no light-mode flash on dark devices. */
export default function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>("auto");

  useEffect(() => {
    const p = readPref();
    setPref(p);
    apply(p);
  }, []);

  const opts: {value: ThemePref; icon: string; title: string}[] = [
    {value: "light", icon: "sun", title: "light theme"},
    {value: "auto", icon: "activity", title: "match system (auto)"},
    {value: "dark", icon: "moon", title: "dark theme"},
  ];

  return (
    <div className="inline-flex items-center gap-0.5 rounded-[10px] border border-[var(--line)] bg-[var(--panel-2)] p-0.5" role="group" aria-label="theme">
      {opts.map((o) => {
        const active = pref === o.value;
        return (
          <button
            key={o.value}
            type="button"
            title={o.title}
            aria-label={o.title}
            onClick={() => {
              setPref(o.value);
              apply(o.value);
            }}
            className="flex h-6 w-6 items-center justify-center rounded-[8px] transition-colors"
            style={{
              color: active ? "var(--accent)" : "var(--muted)",
              background: active ? "var(--accent-soft)" : "transparent",
            }}
          >
            <Icon name={o.icon} size={14} />
          </button>
        );
      })}
    </div>
  );
}