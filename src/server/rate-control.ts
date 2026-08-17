import { MetaAmbiguousError, MetaApiError, MetaTransportError } from "./meta.js";

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);
const AUTH_CODES = new Set([102, 190]);
const AUTH_SUBCODES = new Set([458, 459, 460, 463, 464, 467]);
const PERMISSION_CODES = new Set([10, 200, 294]);
const RESTRICTED_CODES = new Set([368]);

export type RecoveryAction =
  | "retry"
  | "rate_limit"
  | "uncertain"
  | "pause_auth"
  | "pause_permission"
  | "pause_restricted"
  | "permanent";

export type RetryDecision = {
  action: RecoveryAction;
  retryable: boolean;
  rateLimited: boolean;
  delaySeconds: number;
  errorCode?: string;
  assumedSent?: boolean;
};

export function isRateLimitError(error: MetaApiError): boolean {
  return error.status === 429 || (error.code !== undefined && RATE_LIMIT_CODES.has(error.code));
}

function codeLabel(error: MetaApiError): string {
  return [error.code, error.subcode].filter((value) => value !== undefined).join(":") || `http:${error.status}`;
}

export function retryDecision(error: unknown, attempts: number, previousRateLimits = 0): RetryDecision {
  if (error instanceof MetaAmbiguousError) {
    return { action: "uncertain", retryable: true, rateLimited: false, delaySeconds: 300, errorCode: "ambiguous_response" };
  }
  if (error instanceof MetaTransportError) {
    return {
      action: error.ambiguous ? "uncertain" : "retry",
      retryable: true,
      rateLimited: false,
      delaySeconds: error.ambiguous ? 300 : Math.min(3600, Math.max(5, 2 ** Math.min(attempts, 11))),
      errorCode: error.transportCode ?? "network",
    };
  }
  if (!(error instanceof MetaApiError)) {
    return {
      action: "retry", retryable: true, rateLimited: false,
      delaySeconds: Math.min(3600, Math.max(5, 2 ** Math.min(attempts, 11))), errorCode: "internal",
    };
  }

  const errorCode = codeLabel(error);
  if (isRateLimitError(error)) {
    const fallback = Math.min(3600, 60 * 2 ** Math.min(previousRateLimits, 5));
    return {
      action: "rate_limit", retryable: true, rateLimited: true,
      delaySeconds: Math.max(1, error.retryAfterSeconds ?? error.estimatedRecoverySeconds ?? fallback), errorCode,
    };
  }
  if (error.code !== undefined && AUTH_CODES.has(error.code) || error.subcode !== undefined && AUTH_SUBCODES.has(error.subcode)) {
    return { action: "pause_auth", retryable: true, rateLimited: false, delaySeconds: 900, errorCode };
  }
  if (error.code !== undefined && PERMISSION_CODES.has(error.code) || error.status === 403) {
    return { action: "pause_permission", retryable: true, rateLimited: false, delaySeconds: 900, errorCode };
  }
  if (error.code !== undefined && RESTRICTED_CODES.has(error.code)) {
    return { action: "pause_restricted", retryable: true, rateLimited: false, delaySeconds: 3600, errorCode };
  }
  if (/already.+(?:repl|sent)|only one (?:message|reply)/i.test(error.message)) {
    return { action: "permanent", retryable: false, rateLimited: false, delaySeconds: 0, errorCode, assumedSent: true };
  }
  const retryable = error.transient || error.status >= 500 || error.status === 408;
  return {
    action: retryable ? "retry" : "permanent",
    retryable,
    rateLimited: false,
    delaySeconds: retryable ? Math.min(3600, Math.max(5, 2 ** Math.min(attempts, 11))) : 0,
    errorCode,
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
