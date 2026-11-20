/**
 * Small helpers shared by routes: name casing, phone numbers, dates and times.
 */

/**
 * Title Case a person's name the same way everywhere:
 * "jOHN o'brien-smith" → "John O'Brien-Smith", "mary  wanjiru" → "Mary Wanjiru".
 */
export function titleCaseName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/(^|[\s\-'’])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/\bMc(\p{L})/gu, (_m, ch: string) => "Mc" + ch.toUpperCase());
}

/**
 * Normalise a phone number to E.164. Local numbers use the country's prefix:
 * "0712 345 678" with +254 → "+254712345678". Returns null if it is not a phone number.
 */
export function normalizePhone(raw: string, countryPrefix = "+254"): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let digits = trimmed.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) digits = "+" + digits.slice(2);
  if (!digits.startsWith("+")) {
    const prefixDigits = countryPrefix.replace("+", "");
    if (digits.startsWith(prefixDigits) && digits.length > prefixDigits.length + 7) digits = "+" + digits;
    else digits = countryPrefix + digits.replace(/^0+/, "");
  }
  if (!/^\+\d{9,15}$/.test(digits)) return null;
  return digits;
}

/** M-PESA wants 2547XXXXXXXX / 2541XXXXXXXX: Safaricom Kenya numbers only. */
export function mpesaPhone(raw: string): string | null {
  const e164 = normalizePhone(raw, "+254");
  if (!e164 || !/^\+254(7|1)\d{8}$/.test(e164)) return null;
  return e164.slice(1);
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Today's date in a time zone, as YYYY-MM-DD. */
export function today(timeZone = "Africa/Nairobi"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The next date on a weekday (0=Sunday), counting `from` itself. */
export function nextWeekday(weekday: number, from: string): string {
  return addDays(from, (weekday - weekdayOf(from) + 7) % 7);
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Tuesday Session", "Saturday Session": the label follows each intramural's own day. */
export function sessionDayLabel(weekday: number): string {
  return `${WEEKDAYS[weekday]} Session`;
}

/** "15:15" or "15:15:00" → "3:15 PM". Always explicit AM/PM. */
export function formatTime12(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "HH:MM" from a Postgres time. */
export function hhmm(time: string): string {
  return time.slice(0, 5);
}

/** Season label: the calendar year of the date. */
export function seasonOf(date: string): string {
  return date.slice(0, 4);
}
