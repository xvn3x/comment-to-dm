import { MetaApiError } from "./meta.js";

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);

export type RetryDecision = {
  retryable: boolean;
  rateLimited: boolean;
  delaySeconds: number;
};

export function isRateLimitError(error: MetaApiError): boolean {
  return error.status === 429 || (error.code !== undefined && RATE_LIMIT_CODES.has(error.code));
}

export function retryDecision(error: unknown, attempts: number, previousRateLimits = 0): RetryDecision {
  if (!(error instanceof MetaApiError)) return { retryable: false, rateLimited: false, delaySeconds: 0 };
  const rateLimited = isRateLimitError(error);
  if (rateLimited) {
    const fallback = Math.min(3600, 60 * 2 ** Math.min(previousRateLimits, 5));
    return {
      retryable: true,
      rateLimited: true,
      delaySeconds: Math.max(1, error.retryAfterSeconds ?? error.estimatedRecoverySeconds ?? fallback),
    };
  }
  const retryable = error.transient || error.status >= 500 || error.status === 408;
  return {
    retryable,
    rateLimited: false,
    delaySeconds: retryable ? Math.min(3600, Math.max(2, 2 ** Math.min(attempts, 11))) : 0,
  };
}

export function adaptiveIntervalMs(baseIntervalMs: number, usagePercent?: number | null): number {
  if (usagePercent === undefined || usagePercent === null) return baseIntervalMs;
  if (usagePercent >= 90) return Math.max(10_000, baseIntervalMs * 10);
  if (usagePercent >= 80) return Math.max(5_000, baseIntervalMs * 5);
  if (usagePercent >= 60) return Math.max(2_000, baseIntervalMs * 2);
  return baseIntervalMs;
}

export function withJitter(seconds: number, random = Math.random): number {
  return Math.max(1, Math.ceil(seconds * (0.85 + random() * 0.3)));
}
