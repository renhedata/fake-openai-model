import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";
import daisyui from "daisyui";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
        mono: ["JetBrains Mono", "SF Mono", "Fira Code", "monospace"]
      }
    }
  },
  plugins: [typography, daisyui],
  daisyui: {
    themes: [
      {
        light: {
          "primary": "#6366f1",
          "primary-content": "#ffffff",
          "secondary": "#8b5cf6",
          "secondary-content": "#ffffff",
          "accent": "#06b6d4",
          "accent-content": "#ffffff",
          "neutral": "#1e293b",
          "neutral-content": "#f8fafc",
          "base-100": "#ffffff",
          "base-200": "#f8fafc",
          "base-300": "#f1f5f9",
          "base-content": "#1e293b",
          "info": "#3b82f6",
          "info-content": "#ffffff",
          "success": "#10b981",
          "success-content": "#ffffff",
          "warning": "#f59e0b",
          "warning-content": "#ffffff",
          "error": "#ef4444",
          "error-content": "#ffffff",
        }
      },
      "business"
    ],
    darkTheme: "business"
  }
};

export default config;
