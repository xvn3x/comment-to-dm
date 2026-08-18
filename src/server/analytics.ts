export type BucketUnit = "hour" | "day";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const HOURLY_SPAN_LIMIT_MS = 48 * HOUR_MS;
export const MAX_SPAN_MS = 31 * DAY_MS;
export const RETENTION_DAYS = 30;

export type AnalyticsRangeCode = "invalid_range" | "empty_range" | "range_too_long";

export class AnalyticsRangeError extends Error {
  constructor(readonly code: AnalyticsRangeCode) {
    super(code);
  }
}

export type ResolvedRange = { from: Date; to: Date; unit: BucketUnit; sizeMs: number; starts: Date[] };

/**
 * Границы приходят от клиента как абсолютные моменты, посчитанные в его местном времени.
 * Сервер не знает часовой пояс администратора и только раскладывает диапазон на корзины
 * фиксированного размера, поэтому «день» остаётся днём в его календаре.
 */
export function resolveRange(fromInput: string, toInput: string): ResolvedRange {
  const from = new Date(fromInput);
  const to = new Date(toInput);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new AnalyticsRangeError("invalid_range");
  const span = to.getTime() - from.getTime();
  if (span <= 0) throw new AnalyticsRangeError("empty_range");
  if (span > MAX_SPAN_MS) throw new AnalyticsRangeError("range_too_long");
  const unit: BucketUnit = span <= HOURLY_SPAN_LIMIT_MS ? "hour" : "day";
  const sizeMs = unit === "hour" ? HOUR_MS : DAY_MS;
  const starts = Array.from({ length: Math.ceil(span / sizeMs) }, (_, index) => new Date(from.getTime() + index * sizeMs));
  return { from, to, unit, sizeMs, starts };
}

export function bucketIndex(at: Date, range: Pick<ResolvedRange, "from" | "sizeMs">): number {
  return Math.floor((at.getTime() - range.from.getTime()) / range.sizeMs);
}
