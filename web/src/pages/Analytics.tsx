import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { FileDown, LoaderCircle } from "lucide-react";
import { api, download } from "../lib/api";
import { AGE_GROUPS, shortDate } from "../lib/format";
import { ErrorNote, Notice, PageTitle, Spinner } from "../components/ui";

/**
 * Attendance analytics for Super Admins and permitted Admins.
 * Counts come grouped from the server (by session date or by month).
 * Present / excused / absent use the app's own good / warn / bad colours
 * (validated: CVD-safe only with secondary encoding, so the legend, 2px gaps,
 * tooltips and the table view always go with them). The attendance rate is a
 * separate small chart: never a second y-axis on the counts chart.
 */

interface Point { key: string; label: string; present: number; absent: number; excused: number; sessions: number; rate: number | null }
interface Data {
  view: "term" | "year"; year: number; from: string; to: string; termLabel: string; grouping: "session" | "week" | "month";
  points: Point[];
  kpis: { averageRate: number | null; sessionsHeld: number; peakDay: { date: string; present: number } | null; topAgeGroup: { ageGroup: string; rate: number | null } | null };
  filters: { intramurals: { id: number; name: string; programMode: "school" | "club" }[]; coaches: { id: number; name: string }[] };
}

const SERIES = [
  { key: "present", label: "Present", color: "#13996b" },
  { key: "excused", label: "Excused / injury", color: "#c98213" },
  { key: "absent", label: "Absent", color: "#d23b2a" },
] as const;

export function AnalyticsPage() {
  return (
    <>
      <PageTitle banner title="Attendance analytics" sub="Every school and club, by term or by year." />
      <AttendanceAnalytics />
    </>
  );
}

export function AttendanceAnalytics() {
  const thisYear = new Date().getFullYear();
  const [view, setView] = useState<"term" | "year">("term");
  const [year, setYear] = useState(thisYear);
  const [program, setProgram] = useState("all"); // all | school | club | <intramural id>
  const [ageGroup, setAgeGroup] = useState("");
  const [coachId, setCoachId] = useState("");
  const [table, setTable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const params = new URLSearchParams({ view });
  if (view === "year") params.set("year", String(year));
  if (program === "school" || program === "club") params.set("program", program);
  else if (program !== "all") params.set("intramuralId", program);
  if (ageGroup) params.set("ageGroup", ageGroup);
  if (coachId) params.set("coachId", coachId);
  const qs = params.toString();
  const q = useQuery({ queryKey: ["analytics", qs], queryFn: () => api<Data>(`/analytics/attendance?${qs}`), placeholderData: (prev) => prev });

  const exportCsv = async () => {
    setBusy(true);
    setError("");
    try {
      await download(`/analytics/attendance?${qs}&format=csv`, `attendance-${view === "year" ? year : "term"}.csv`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (q.error) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const k = d?.kpis;
  const empty = d && d.points.every((p) => p.present + p.absent + p.excused === 0);

  return (
    <section aria-label="Attendance analytics" className="grid gap-4">
      {/* Filters: one row above the charts. */}
      <div className="sheet grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="radiogroup" aria-label="Timeframe" className="inline-flex rounded-full bg-page p-1 ring-1 ring-line">
            {(["term", "year"] as const).map((v) => (
              <button key={v} role="radio" aria-checked={view === v} onClick={() => setView(v)}
                className={`rounded-full px-4 py-2 text-sm font-bold ${view === v ? "bg-navy text-white" : "text-slate"}`}>
                {v === "term" ? "Whole term" : "Whole year"}
              </button>
            ))}
          </div>
          <button className="btn-ghost" onClick={exportCsv} disabled={busy || !d}>
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />} Export CSV
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Select label="Program / venue" value={program} onChange={setProgram}>
            <option value="all">All programs</option>
            <option value="school">Schools · 4 Virtue Teams</option>
            <option value="club">Clubs · camps & events</option>
            {d?.filters.intramurals.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </Select>
          <Select label="Age group" value={ageGroup} onChange={setAgeGroup}>
            <option value="">All ages</option>
            {AGE_GROUPS.map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>
          <Select label="Coach" value={coachId} onChange={setCoachId}>
            <option value="">All coaches</option>
            {d?.filters.coaches.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          {view === "year" ? (
            <Select label="Year" value={String(year)} onChange={(v) => setYear(Number(v))}>
              {[thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
          ) : (
            <div className="min-w-0">
              <p className="label">Term</p>
              <p className="truncate py-2.5 text-[15px] font-semibold text-navy" title={d?.termLabel}>
                {d ? (d.termLabel.includes(" to ") ? `${shortDate(d.from)} to ${shortDate(d.to)}` : d.termLabel) : "…"}
              </p>
            </div>
          )}
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
      </div>

      {!d ? <Spinner /> : (
        <>
          {/* Summary tiles. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="Average attendance" value={k!.averageRate == null ? "None yet" : `${k!.averageRate}%`} />
            <Kpi label="Sessions held" value={String(k!.sessionsHeld)} />
            <Kpi label="Peak attendance day" value={k!.peakDay ? shortDate(k!.peakDay.date) : "None yet"} note={k!.peakDay ? `${k!.peakDay.present} players present` : undefined} />
            <Kpi label="Highest-attending age group" value={k!.topAgeGroup?.ageGroup ?? "None yet"} note={k!.topAgeGroup?.rate != null ? `${k!.topAgeGroup.rate}% attendance` : undefined} />
          </div>

          <div className={`sheet transition-opacity ${q.isFetching ? "opacity-60" : ""}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-bold text-navy">
                Players per {d.grouping === "month" ? "month" : d.grouping === "week" ? "week" : "session"}
              </h3>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink" aria-label="Legend">
                {SERIES.map((s) => (
                  <li key={s.key} className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden /> {s.label}
                  </li>
                ))}
              </ul>
            </div>
            {empty ? (
              <p className="py-14 text-center text-[15px] text-slate">No attendance recorded for these filters yet.</p>
            ) : (
              <div className="mt-3 h-64" role="img" aria-label={`Stacked bars of present, excused and absent players per ${d.grouping}. Table view below.`}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={d.points} margin={{ top: 4, right: 4, left: -18, bottom: 0 }} barCategoryGap="22%">
                    <CartesianGrid vertical={false} stroke="#e8edf5" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#5b6690" }} tickLine={false} axisLine={{ stroke: "#d9e0ec" }} interval="preserveStartEnd" minTickGap={8} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#5b6690" }} tickLine={false} axisLine={false} />
                    <Tooltip content={<CountTip />} cursor={{ fill: "rgb(15 33 71 / 0.06)" }} />
                    {SERIES.map((s, n) => (
                      <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a" fill={s.color} stroke="#fff" strokeWidth={2}
                        radius={n === SERIES.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={36} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          {!empty && (
            <div className={`sheet transition-opacity ${q.isFetching ? "opacity-60" : ""}`}>
              <h3 className="font-bold text-navy">Attendance rate</h3>
              <p className="text-sm text-slate">Present (including late) out of everyone recorded.</p>
              <div className="mt-3 h-40" role="img" aria-label={`Line of the attendance rate per ${d.grouping}, 0 to 100 percent.`}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={d.points} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="#e8edf5" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#5b6690" }} tickLine={false} axisLine={{ stroke: "#d9e0ec" }} interval="preserveStartEnd" minTickGap={8} />
                    <YAxis domain={[0, 100]} ticks={[0, 50, 100]} unit="%" tick={{ fontSize: 11, fill: "#5b6690" }} tickLine={false} axisLine={false} />
                    <Tooltip content={<RateTip />} cursor={{ stroke: "#0f2147", strokeDasharray: "3 3" }} />
                    <Line type="monotone" dataKey="rate" stroke="#2f5bd3" strokeWidth={2} connectNulls
                      dot={{ r: 4, fill: "#2f5bd3", stroke: "#fff", strokeWidth: 2 }} activeDot={{ r: 6, stroke: "#fff", strokeWidth: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <div className="sheet">
            <button className="text-sm font-semibold text-brand" onClick={() => setTable(!table)} aria-expanded={table}>
              {table ? "Hide the table" : "Show as a table"}
            </button>
            {table && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-slate">
                    <tr><th className="py-1.5 pr-3">{d.grouping === "month" ? "Month" : d.grouping === "week" ? "Week of" : "Date"}</th><th className="pr-3 text-right">Present</th><th className="pr-3 text-right">Excused / injury</th><th className="pr-3 text-right">Absent</th><th className="text-right">Rate</th></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {d.points.map((p) => (
                      <tr key={p.key}>
                        <td className="py-1.5 pr-3 font-semibold text-navy">{p.label}</td>
                        <td className="pr-3 text-right tabular-nums">{p.present}</td>
                        <td className="pr-3 text-right tabular-nums">{p.excused}</td>
                        <td className="pr-3 text-right tabular-nums">{p.absent}</td>
                        <td className="text-right tabular-nums">{p.rate == null ? "" : `${p.rate}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <label className="min-w-0">
      <span className="label">{label}</span>
      <select className="field py-2" value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>
    </label>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="sheet !p-4">
      <p className="text-xs font-semibold text-slate">{label}</p>
      <p className="display mt-1 text-[1.9rem] text-navy">{value}</p>
      {note && <p className="text-xs text-slate">{note}</p>}
    </div>
  );
}

function CountTip({ active, payload, label }: { active?: boolean; payload?: { payload: Point }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-xl bg-white px-3 py-2 text-sm shadow-lg ring-1 ring-line">
      <p className="font-bold text-navy">{label}</p>
      {SERIES.map((s) => (
        <p key={s.key} className="flex items-center gap-2 text-ink">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
          {s.label}: <strong className="tabular-nums">{p[s.key]}</strong>
        </p>
      ))}
      <p className="mt-1 text-slate">{p.rate == null ? "No records" : `${p.rate}% attendance`} · {p.sessions} session{p.sessions === 1 ? "" : "s"}</p>
    </div>
  );
}

function RateTip({ active, payload, label }: { active?: boolean; payload?: { payload: Point }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-xl bg-white px-3 py-2 text-sm shadow-lg ring-1 ring-line">
      <p className="font-bold text-navy">{label}</p>
      <p className="text-ink">{p.rate == null ? "No records" : `${p.rate}% attendance`}</p>
    </div>
  );
}
