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

export const AGE_GROUPS = ["U7", "U9", "U11", "U13", "U15", "U17"];

/** Age group for a birth year this season (born 2017 → U11 in 2026). */
export function ageGroupFor(birthYear: number, seasonYear = Number(today().slice(0, 4))): string {
  const age = seasonYear - birthYear;
  for (const g of AGE_GROUPS) if (age < Number(g.slice(1))) return g;
  return "U17";
}

/** What to call a session: "Tuesday session", "Match vs Daniels", "Summer Camp". */
export function sessionLabel(s: { kind: string; title?: string; opponent?: string; dayLabel?: string; date: string }): string {
  switch (s.kind) {
    case "match": return `Match${s.opponent ? ` vs ${s.opponent}` : ""}`;
    case "tournament": return s.title || "Tournament";
    case "camp": return s.title || "Camp";
    case "clinic": return s.title || "Clinic";
    default: return `${s.dayLabel ?? dayName(s.date)} session`;
  }
}

/** "Wed 16 Dec" or, for a multi-day camp, "Wed 16 – Fri 18 Dec". */
export function dateRange(date: string, endDate?: string | null): string {
  if (!endDate || endDate <= date) return shortDate(date);
  const a = new Date(`${date}T00:00:00Z`);
  const b = new Date(`${endDate}T00:00:00Z`);
  const sameMonth = a.getUTCMonth() === b.getUTCMonth();
  const left = a.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", ...(sameMonth ? {} : { month: "short" }), timeZone: "UTC" });
  return `${left} – ${shortDate(endDate)}`;
}

/** Airtable share link → embeddable form URL (airtable.com/appX/shrY → airtable.com/embed/appX/shrY). */
export function airtableEmbedUrl(url: string): string | null {
  const m = url.match(/^https:\/\/airtable\.com\/(?:embed\/)?((?:app[A-Za-z0-9]+\/)?shr[A-Za-z0-9]+)/);
  return m ? `https://airtable.com/embed/${m[1]}` : null;
}
