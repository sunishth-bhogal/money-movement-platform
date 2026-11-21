import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The user wallet. In development (`npm run wallet`) Vite serves it on :5174
// and forwards /me to the API on :3000. `npm run wallet:build` writes
// wallet/dist, which the API serves at /wallet/.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/wallet/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5174, proxy: { "/me": process.env.API_URL ?? "http://localhost:3000" } },
});
