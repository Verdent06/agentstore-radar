"use client";

import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [mode, setMode] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const stored = window.localStorage.getItem("radar-theme");
    const next = stored === "light" ? "light" : "dark";
    setMode(next);
    document.documentElement.classList.toggle("light", next === "light");
  }, []);

  function toggle() {
    const next = mode === "dark" ? "light" : "dark";
    setMode(next);
    window.localStorage.setItem("radar-theme", next);
    document.documentElement.classList.toggle("light", next === "light");
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className="rounded-md border border-line px-2.5 py-1 text-[11px] uppercase tracking-wide text-muted hover:text-ink"
      aria-label="Toggle color theme"
    >
      {mode === "dark" ? "Light" : "Dark"}
    </button>
  );
}
