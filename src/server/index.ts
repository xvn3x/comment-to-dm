import "dotenv/config";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { buildApp } from "./app.js";
import { startWorker } from "./worker.js";
import { startCommentRecovery } from "./comment-recovery-runner.js";

const config = loadConfig();
const sql = await createDb(config.DATABASE_URL);
const { app, meta, box } = await buildApp(sql, config);
const stopWorker = startWorker(sql, config, meta, box);
const stopCommentRecovery = startCommentRecovery(sql, config, meta, box);

const shutdown = async () => {
  await stopCommentRecovery();
  await stopWorker();
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
