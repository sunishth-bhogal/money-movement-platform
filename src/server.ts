import { buildApp } from "./app.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";

const pool = createPool();
await migrate(pool);
const app = buildApp(pool, { logger: true });
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
