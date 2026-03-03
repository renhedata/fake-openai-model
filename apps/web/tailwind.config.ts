import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";
import daisyui from "daisyui";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "#ffffff",
        page: "#f8fafc",
        ink: "#0f172a"
      }
    }
  },
  plugins: [typography, daisyui],
  daisyui: {
    themes: ["light"]
  }
};

export default config;
