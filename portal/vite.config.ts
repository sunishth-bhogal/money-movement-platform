import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The ticket portal: a public box office, and the organizer's payout pages.
// In development (`npm run portal`) Vite serves it on :5175 and forwards the
// API routes to :3000. `npm run portal:build` writes portal/dist, which the
// API serves at /portal/.
const api = process.env.API_URL ?? "http://localhost:3000";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/portal/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5175, proxy: { "/organizer": api, "/box-office": api } },
});
