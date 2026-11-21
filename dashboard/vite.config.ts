import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The admin dashboard. In development (`npm run dashboard`) Vite serves it on
// :5173 and forwards /admin to the API on :3000. `npm run dashboard:build`
// writes dashboard/dist, which the API serves at /dashboard/.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/dashboard/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { port: 5173, proxy: { "/admin": process.env.API_URL ?? "http://localhost:3000" } },
});
