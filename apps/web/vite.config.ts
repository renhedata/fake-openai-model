import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendTarget = env.VITE_BACKEND_URL || "http://localhost:3001";

  return {
    plugins: [react()],
    server: {
      port: 3000,
      proxy: {
        "/v1": backendTarget,
        "/proxy": backendTarget,
        "/events": backendTarget,
        "/trpc": backendTarget,
        "/health": backendTarget
      }
    },
    build: {
      outDir: "dist",
      emptyOutDir: true
    }
  };
});
