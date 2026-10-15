import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./lib/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      // Dark-only palette. Polarity uses the blue/red diverging pair; status colors are
      // reserved for state (ok / degraded / flags) and always ship with an icon + label.
      colors: {
        plane: "#0d0d0d",
        surface: "#1a1a19",
        raised: "#232321",
        ink: "#f0efec",
        ink2: "#c3c2b7",
        muted: "#898781",
        grid: "#2c2c2a",
        axis: "#383835",
        bull: "#3987e5",
        bear: "#e66767",
        good: "#0ca30c",
        warn: "#fab219",
        serious: "#ec835a",
        critical: "#d03b3b",
      },
    },
  },
  plugins: [],
};

export default config;
