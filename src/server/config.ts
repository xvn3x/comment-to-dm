import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1).default("postgres://commentdm:commentdm@localhost:5432/commentdm"),
  ADMIN_PASSWORD: z.string().min(10).default("local-development-only"),
  SESSION_SECRET: z.string().min(32).default("local-session-secret-change-me-000000000000"),
  ENCRYPTION_KEY: z.string().min(43).default("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
  META_MODE: z.enum(["live", "mock"]).default("mock"),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v25.0"),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(16).default("local-webhook-verify-token"),
  META_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(20_000),
  QUEUE_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(1000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(20),
  PROCESSING_TIMEOUT_SECONDS: z.coerce.number().int().min(60).max(3600).default(180),
  SURGE_ENTER_PRIVATE_JOBS: z.coerce.number().int().min(100).max(100_000).default(1000),
  SURGE_EXIT_PRIVATE_JOBS: z.coerce.number().int().min(10).max(50_000).default(250),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = schema.parse(env);
  if (config.NODE_ENV === "production") {
    const insecure = [
      config.ADMIN_PASSWORD === "local-development-only",
      config.SESSION_SECRET.startsWith("local-session-secret"),
      config.ENCRYPTION_KEY.startsWith("AAAA"),
      config.META_WEBHOOK_VERIFY_TOKEN.startsWith("local-webhook"),
    ];
    if (insecure.some(Boolean)) {
      throw new Error("Production secrets are not configured. Review .env.example before starting.");
    }
    if (!config.PUBLIC_BASE_URL.startsWith("https://")) {
      throw new Error("PUBLIC_BASE_URL must use HTTPS in production.");
    }
  }
  return config;
}
