import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ground: "#f2efe9",
        surface: "#e7e2d8",
        card: "#faf8f4",
        ink: "#1c1d1f",
        muted: "#5c5e62",
        accent: "#c2501b",
        "accent-ink": "#ffffff",
        line: "#d8d2c6",
      },
      fontFamily: {
        display: ['"Space Grotesk"', "system-ui", "sans-serif"],
        sans: ['"Space Grotesk"', "system-ui", "sans-serif"],
        mono: ['"DM Mono"', "ui-monospace", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
