/** Shared display rules: Title Case names, explicit AM/PM, each intramural's own day. */

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "jOHN o'brien" → "John O'Brien" (same rule as the server). */
export function titleCase(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/(^|[\s\-'’])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())
    .replace(/\bMc(\p{L})/gu, (_m, ch: string) => "Mc" + ch.toUpperCase());
}

/** "15:15" → "3:15 PM" */
export function time12(t: string): string {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function dayName(date: string): string {
  return WEEKDAYS[weekdayOf(date)];
}

/** "Tue 24 Nov" */
export function shortDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export function longDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(new Date());
}

/** Relative day: "Today", "Tomorrow", or "Saturday". */
export function relativeDay(date: string): string {
  const t = today();
  if (date === t) return "Today";
  const tomorrow = new Date(`${t}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (date === tomorrow.toISOString().slice(0, 10)) return "Tomorrow";
  const days = (new Date(`${date}T00:00:00Z`).getTime() - new Date(`${t}T00:00:00Z`).getTime()) / 86_400_000;
  if (days > 0 && days < 7) return dayName(date);
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function dateTime12(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).replace(/\b(am|pm)\b/, (m) => m.toUpperCase());
}

export function money(amount: number, currency = "KES"): string {
  return `${currency} ${Number(amount).toLocaleString("en-KE", { maximumFractionDigits: 2 })}`;
}

export const VIRTUE_LABELS: Record<string, string> = {
  temperance: "Temperance", wisdom: "Wisdom", fortitude: "Fortitude", justice: "Justice", teamwork: "Teamwork", discipline: "Discipline",
};

export const PERMISSION_LABELS: Record<string, string> = {
  "schedules.edit": "Can edit schedules and Setup",
  "players.register": "Can register players",
  "roles.assign": "Can assign coach roles",
  "airtable.manage": "Can manage Airtable links",
  "parents.approve": "Can approve parent accounts",
  "attendance.take": "Can take attendance",
  "equipment.check": "Can run the equipment checklist",
  "payments.manage": "Can manage fees and payments",
  "reports.generate": "Can generate matchday reports",
  "privileges.grant": "Can grant field privileges to coaches",
  "country.override": "Can work outside their country",
};
