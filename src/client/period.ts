import type { Period } from "./types";

export const DAY_MS = 86_400_000;
export const RETENTION_DAYS = 30;
export const MAX_RANGE_DAYS = 31;

export type PeriodBounds = { from: Date; to: Date } | "invalid" | "too_long";

export function toDateInput(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function fromDateInput(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Текущая местная дата как якорь: «Сегодня» не должно зависеть от момента открытия вкладки. */
export function todayAnchor(now: Date = new Date()) {
  return toDateInput(now);
}

/**
 * Следующая местная полночь считается календарно, а не как «сейчас + 24 часа»,
 * иначе вкладка, открытая днём, переключит день в неверный момент.
 */
export function nextLocalMidnight(now: Date = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
}

export function retentionMinDate(anchor: string) {
  const today = fromDateInput(anchor);
  return today ? toDateInput(addDays(today, 1 - RETENTION_DAYS)) : anchor;
}

/**
 * Границы периода в местном времени администратора. Якорь дня передаётся снаружи,
 * поэтому результат детерминирован и проверяется тестами без подмены часов.
 */
export function periodBounds(period: Period, anchor: string): PeriodBounds {
  const today = fromDateInput(anchor);
  if (!today) return "invalid";
  if (period.kind === "today") return { from: today, to: addDays(today, 1) };
  if (period.kind === "all") return { from: addDays(today, 1 - RETENTION_DAYS), to: addDays(today, 1) };
  if (period.kind === "date") {
    const day = fromDateInput(period.date);
    return day ? { from: day, to: addDays(day, 1) } : "invalid";
  }
  const from = fromDateInput(period.from);
  const last = fromDateInput(period.to);
  if (!from || !last || last.getTime() < from.getTime()) return "invalid";
  const to = addDays(last, 1);
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) return "too_long";
  return { from, to };
}
