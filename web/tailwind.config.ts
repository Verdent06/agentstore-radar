import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class", "html"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        elev: "var(--bg-elev)",
        line: "var(--line)",
        muted: "var(--muted)",
        ink: "var(--text)",
        accent: "var(--accent)",
        up: "var(--up)",
        down: "var(--down)",
        warn: "var(--warn)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      boxShadow: {
        card: "0 1px 0 rgba(255,255,255,0.03) inset, 0 12px 40px rgba(0,0,0,0.25)",
      },
    },
  },
  plugins: [],
};

export default config;
