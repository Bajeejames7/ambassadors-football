import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, ChevronRight, ClipboardCheck, FileDown, LoaderCircle, Users } from "lucide-react";
import { api, download, ApiError } from "../lib/api";
import { cached, enqueue, useOffline } from "../lib/offline";
import { useAuth } from "../lib/auth";
import { useIntramural, useIntramurals, useUpcoming, type Intramural, type Session } from "../lib/queries";
import { dateRange, longDate, sessionLabel, shortDate, time12, WEEKDAYS } from "../lib/format";
import { Crest, Empty, ErrorNote, FixtureBoard, Modal, Notice, PageTitle, PendingBadge, SectionTitle, Spinner } from "../components/ui";

export function StaffHome() {
  const { me } = useAuth();
  const list = useIntramurals();
  if (list.isLoading) return <Spinner />;
  if (list.error) return <ErrorNote error={list.error} onRetry={() => list.refetch()} />;
  const items = list.data!;
  const first = me!.name.split(" ")[0];
  return (
    <>
      <PageTitle banner title={`Hello, ${first}`} sub={me!.role === "super_admin" ? "Super Admin · every school and club" : me!.role === "admin" ? "Admin · every school and club" : "Coach"} />
      {items.length === 0 ? (
        <div className="sheet">
          <h2 className="condensed text-xl text-navy">You're not on a team yet</h2>
          <p className="mt-2 text-[15px] text-slate">Ask your coordinator to add you to your school. Once they do, your sessions, roster and check-in appear here.</p>
        </div>
      ) : (
        <>
          {items[0].nextSession && (
            <FixtureBoard
              s={{ ...(items[0].nextSession as Session), dayLabel: WEEKDAYS[new Date(`${items[0].nextSession.date}T00:00:00Z`).getUTCDay()], intramuralName: items[0].name }}
              footer={
                <div className="flex flex-wrap gap-2">
                  <Link to={`/s/${items[0].nextSession.id}/field`} className="btn bg-white text-navy"><ClipboardCheck className="h-4 w-4" /> Field check-in</Link>
                  <Link to={`/s/${items[0].nextSession.id}`} className="btn bg-white/10 text-white ring-1 ring-white/30">Session plan</Link>
                </div>
              }
            />
          )}
          <SectionTitle>Your {items.length === 1 ? "school" : "schools and clubs"}</SectionTitle>
          <ul className="grid gap-3">
            {items.map((i) => (
              <li key={i.id}>
                <Link to={`/i/${i.id}`} className="sheet flex items-center gap-3 hover:ring-brand">
                  <Crest i={i} size={46} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[17px] font-bold text-navy">{i.name}</p>
                    <p className="text-sm text-slate">
                      {WEEKDAYS[i.sessionWeekday]}s, {time12(i.sessionStart)}{me!.isSuperAdmin ? ` · ${i.countryName}` : ""}
                    </p>
                  </div>
                  {i.nextSession && <span className="hidden text-sm font-semibold text-slate sm:block">Next: {shortDate(i.nextSession.date)}</span>}
                  <ChevronRight className="h-5 w-5 text-slate" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** Upcoming sessions everywhere the person can see (parents: their children's). */
export function SchedulePage() {
  const up = useUpcoming();
  const { me } = useAuth();
  if (up.isLoading) return <Spinner />;
  if (up.error) return <ErrorNote error={up.error} onRetry={() => up.refetch()} />;
  const byDate = new Map<string, Session[]>();
  for (const s of up.data!) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
  return (
    <>
      <PageTitle banner title="Schedule" sub="The next five weeks. Times are local." />
      {byDate.size === 0 && <Empty>No sessions in the next five weeks.</Empty>}
      <div className="grid gap-5">
        {[...byDate].map(([date, list]) => (
          <section key={date}>
            <h2 className="condensed mb-2 text-lg text-navy">{longDate(date)}</h2>
            <ul className="grid gap-3">
              {list.map((s) => {
                const body = (
                  <div className={`sheet flex gap-3 ${s.cancelled ? "opacity-60" : ""}`}>
                    <span className="w-1.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-navy">
                        {s.intramuralName} · {sessionLabel(s)}{s.endDate && s.endDate > s.date ? ` (${dateRange(s.date, s.endDate)})` : ""}
                        {s.cancelled && <span className="chip ml-2 bg-bad text-white">Cancelled</span>}
                      </p>
                      <p className="display mt-1 text-xl text-navy">{s.timeLabel}</p>
                      {s.location && <p className="text-sm text-slate">Pitch: {s.location}</p>}
                      {s.dressCode && <p className="text-sm text-slate">Kit: {s.dressCode}</p>}
                      {s.travelNotes && <p className="mt-1 text-sm">{s.travelNotes}</p>}
                    </div>
                  </div>
                );
                return <li key={s.id}>{me!.role === "parent" ? body : <Link to={`/s/${s.id}`}>{body}</Link>}</li>;
              })}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

/** Session plan: schedule, coach roles, availability poll, logistics, report. */
export function SessionPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { online } = useOffline();
  const q = useQuery({ queryKey: ["session", Number(id)], queryFn: () => cached<any>(`/sessions/${id}`) });
  const intramural = useIntramural(q.data?.intramuralId ?? 0);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data;
  const i = intramural.data;
  const perms = i?.myPermissions ?? [];
  const options = i?.availabilityOptions ?? [];

  const answer = async (optionId: string) => {
    if (!online) {
      await enqueue("availability", { sessionId: s.id, optionId }, `Availability for ${shortDate(s.date)}`);
      setMsg({ tone: "good", text: "Saved on this phone. It will sync when you're back online." });
      return;
    }
    await api(`/sessions/${s.id}/availability`, { method: "PUT", body: { optionId } });
    void qc.invalidateQueries({ queryKey: ["session", s.id] });
  };

  const assign = async (role: string, userId: number | null) => {
    try {
      const roles = s.roles.map((r: any) => ({ role: r.role, userId: r.role === role ? userId : r.userId }));
      await api(`/sessions/${s.id}`, { method: "PATCH", body: { version: s.version, roles } });
      void qc.invalidateQueries({ queryKey: ["session", s.id] });
    } catch (err) {
      setMsg({ tone: "bad", text: (err as Error).message });
      void qc.invalidateQueries({ queryKey: ["session", s.id] });
    }
  };

  const report = async () => {
    setBusy(true);
    try {
      await download(`/sessions/${s.id}/report.pdf`, `matchday-report-${s.date}.pdf`);
    } catch (err) {
      setMsg({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const counts = options.map((o) => ({ ...o, n: (s.poll ?? []).filter((p: any) => p.optionId === o.id).length }));

  return (
    <>
      <FixtureBoard s={{ ...s, intramuralName: i?.name }} footer={
        <div className="flex flex-wrap gap-2">
          <Link to={`/s/${s.id}/field`} className="btn bg-white text-navy"><ClipboardCheck className="h-4 w-4" /> Field check-in</Link>
          {perms.includes("reports.generate") && (
            <button onClick={report} disabled={busy || !online} className="btn bg-white/10 text-white ring-1 ring-white/30">
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />} Matchday report (PDF)
            </button>
          )}
          {s.canEdit && <button onClick={() => setEditing(true)} className="btn bg-white/10 text-white ring-1 ring-white/30">Edit logistics</button>}
        </div>
      } />
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {s.travelNotes && <p className="sheet mt-3 text-[15px]">{s.travelNotes}</p>}

      <SectionTitle>Will you be there?</SectionTitle>
      <div className="grid gap-2">
        {options.map((o) => (
          <button key={o.id} onClick={() => answer(o.id)} aria-pressed={s.myAnswer === o.id}
            className={`flex items-center justify-between rounded-2xl px-4 py-3 text-left text-[15px] font-semibold ring-1 ${s.myAnswer === o.id ? (o.tone === "bad" ? "bg-bad text-white ring-bad" : o.tone === "ok" ? "bg-warn text-white ring-warn" : "bg-good text-white ring-good") : "bg-white ring-line"}`}>
            {o.label}
            <span className="text-sm opacity-80">{counts.find((c) => c.id === o.id)?.n ?? 0}</span>
          </button>
        ))}
      </div>
      {(s.poll ?? []).length > 0 && (
        <details className="mt-2 text-sm text-slate">
          <summary className="cursor-pointer font-semibold">Who answered ({s.poll.length})</summary>
          <ul className="mt-2 grid gap-1">
            {s.poll.map((p: any) => <li key={p.userId}>{p.name}: {options.find((o) => o.id === p.optionId)?.label}</li>)}
          </ul>
        </details>
      )}

      <SectionTitle>Coach roles</SectionTitle>
      <ul className="sheet divide-y divide-line py-1">
        {s.roles.map((r: any) => (
          <li key={r.role} className="flex items-center justify-between gap-3 py-2.5">
            <span className="text-[15px] font-semibold">{r.role}</span>
            {s.canAssignRoles ? (
              <select className="field max-w-[55%] py-1.5 text-sm" value={r.userId ?? ""} onChange={(e) => assign(r.role, e.target.value ? Number(e.target.value) : null)} aria-label={`Coach for ${r.role}`}>
                <option value="">Unassigned</option>
                {s.coaches.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            ) : (
              <span className="text-[15px] text-slate">{r.name || "Unassigned"}</span>
            )}
          </li>
        ))}
        {s.roles.length === 0 && <li className="py-3 text-slate">No roles set for this session.</li>}
      </ul>

      <SectionTitle>Session plan</SectionTitle>
      {s.schedule.length ? (
        <ol className="sheet py-2">
          {s.schedule.map((row: any, k: number) => (
            <li key={k} className="grid grid-cols-[5.5rem_1fr] gap-3 py-2">
              <span className="condensed text-[15px] text-navy">{time12(row.time)}</span>
              <span className="text-[15px]">{row.activity}</span>
            </li>
          ))}
        </ol>
      ) : (
        <Empty>No timetable for this session.</Empty>
      )}
      {editing && i && <EditSession s={s} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void qc.invalidateQueries({ queryKey: ["session", s.id] }); void qc.invalidateQueries({ queryKey: ["upcoming"] }); }} />}
    </>
  );
}

function EditSession({ s, onClose, onSaved }: { s: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ startTime: s.startTime, endTime: s.endTime, location: s.location, dressCode: s.dressCode, travelNotes: s.travelNotes, title: s.title, opponent: s.opponent, cancelled: s.cancelled });
  const [schedule, setSchedule] = useState<{ time: string; activity: string }[]>(s.schedule);
  const [error, setError] = useState("");
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(`/sessions/${s.id}`, { method: "PATCH", body: { version: s.version, ...f, schedule: schedule.filter((r) => r.activity.trim()) } });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "Someone else saved this session first. Close and reopen to see their changes." : (err as Error).message);
    }
  };
  return (
    <Modal open onClose={onClose} title="Edit session">
      <form onSubmit={save} className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="st">Starts</label><input id="st" type="time" className="field" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /><p className="mt-1 text-xs text-slate">{time12(f.startTime)}</p></div>
          <div><label className="label" htmlFor="en">Ends</label><input id="en" type="time" className="field" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} /><p className="mt-1 text-xs text-slate">{time12(f.endTime)}</p></div>
        </div>
        {s.kind !== "training" && <div><label className="label" htmlFor="ttl">Title</label><input id="ttl" className="field" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>}
        {s.kind === "match" && <div><label className="label" htmlFor="opp">Opponent</label><input id="opp" className="field" value={f.opponent} onChange={(e) => setF({ ...f, opponent: e.target.value })} /></div>}
        <div><label className="label" htmlFor="loc">Pitch / location</label><input id="loc" className="field" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></div>
        <div><label className="label" htmlFor="dc">Kit / dress code</label><input id="dc" className="field" value={f.dressCode} onChange={(e) => setF({ ...f, dressCode: e.target.value })} /></div>
        <div><label className="label" htmlFor="tn">Travel arrangements</label><textarea id="tn" className="field" rows={2} value={f.travelNotes} onChange={(e) => setF({ ...f, travelNotes: e.target.value })} /></div>
        <ScheduleEditor value={schedule} onChange={setSchedule} />
        <label className="flex items-center gap-2 text-[15px] font-semibold text-bad"><input type="checkbox" checked={f.cancelled} onChange={(e) => setF({ ...f, cancelled: e.target.checked })} /> Cancel this session (parents are told)</label>
        {error && <Notice tone="bad">{error}</Notice>}
        <button className="btn-primary">Save session</button>
      </form>
    </Modal>
  );
}

export function ScheduleEditor({ value, onChange }: { value: { time: string; activity: string }[]; onChange: (v: { time: string; activity: string }[]) => void }) {
  return (
    <fieldset>
      <legend className="label">Timetable</legend>
      <div className="grid gap-2">
        {value.map((r, k) => (
          <div key={k} className="flex gap-2">
            <input type="time" className="field w-32" value={r.time} aria-label="Time" onChange={(e) => onChange(value.map((x, n) => (n === k ? { ...x, time: e.target.value } : x)))} />
            <input className="field" value={r.activity} aria-label="Activity" onChange={(e) => onChange(value.map((x, n) => (n === k ? { ...x, activity: e.target.value } : x)))} />
            <button type="button" className="px-2 text-slate" aria-label="Remove row" onClick={() => onChange(value.filter((_, n) => n !== k))}>×</button>
          </div>
        ))}
        <button type="button" className="btn-ghost justify-self-start" onClick={() => onChange([...value, { time: value.at(-1)?.time ?? "15:00", activity: "" }])}>Add a row</button>
      </div>
    </fieldset>
  );
}

/** Sessions tab of an intramural hub. */
export function SessionsTab({ i }: { i: Intramural }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["sessions", i.id], queryFn: () => cached<Session[]>(`/intramurals/${i.id}/sessions`) });
  const [adding, setAdding] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const upcoming = q.data!.filter((s) => s.date >= today);
  const past = q.data!.filter((s) => s.date < today).reverse();
  const row = (s: Session) => (
    <li key={s.id}>
      <Link to={`/s/${s.id}`} className={`sheet flex items-center gap-3 hover:ring-brand ${s.cancelled ? "opacity-60" : ""}`}>
        <div className="w-16 shrink-0 text-center">
          <p className="text-xs font-semibold text-slate">{s.dayLabel.slice(0, 3)}</p>
          <p className="display text-3xl text-navy">{s.date.slice(8)}</p>
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-navy">{sessionLabel(s)}{s.kind === "camp" || s.kind === "clinic" ? <span className="chip ml-2 bg-warn/15 text-warn">{s.kind === "camp" ? "Camp" : "Clinic"}</span> : null}</p>
          <p className="text-sm text-slate">{s.endDate && s.endDate > s.date ? `${dateRange(s.date, s.endDate)} · ` : ""}{s.timeLabel}{s.cancelled ? " · Cancelled" : ""}</p>
        </div>
        {s.myAnswer === undefined || s.myAnswer ? null : <span className="chip bg-brand/10 text-brand">Answer poll</span>}
        <ChevronRight className="h-5 w-5 text-slate" aria-hidden />
      </Link>
    </li>
  );
  return (
    <>
      {i.myPermissions.includes("schedules.edit") && (
        <button className="btn-ghost mb-3" onClick={() => setAdding(true)}><CalendarPlus className="h-4 w-4" /> {i.programMode === "club" ? "Add an event, camp or match" : "Add match or tournament"}</button>
      )}
      <ul className="grid gap-3">{upcoming.map(row)}</ul>
      {past.length > 0 && (
        <>
          <SectionTitle>Past sessions</SectionTitle>
          <ul className="grid gap-3">{past.slice(0, 8).map(row)}</ul>
        </>
      )}
      {adding && <AddFixture i={i} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void qc.invalidateQueries({ queryKey: ["sessions", i.id] }); }} />}
    </>
  );
}

function AddFixture({ i, onClose, onSaved }: { i: Intramural; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ kind: i.programMode === "club" ? "camp" : "match", date: "", endDate: "", title: "", opponent: "", startTime: i.sessionStart, endTime: i.sessionEnd, location: i.location, dressCode: i.dressCode, travelNotes: "" });
  const [error, setError] = useState("");
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(`/intramurals/${i.id}/sessions`, { method: "POST", body: { ...f, endDate: f.kind === "camp" && f.endDate ? f.endDate : null } });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal open onClose={onClose} title={i.programMode === "club" ? "Add an event or camp" : "Add a fixture"}>
      <form onSubmit={save} className="grid gap-3">
        <div className="grid grid-cols-2 gap-2">
          {((i.programMode === "club" ? ["camp", "clinic", "tournament", "match", "training"] : ["match", "tournament", "training"]) as ("camp" | "clinic" | "match" | "tournament" | "training")[]).map((k) => (
            <button type="button" key={k} onClick={() => setF({ ...f, kind: k })} className={`rounded-xl px-3 py-2 text-sm font-semibold ring-1 ${f.kind === k ? "bg-navy text-white ring-navy" : "ring-line"}`}>
              {k === "training" ? "Extra training" : k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
        <div className={f.kind === "camp" ? "grid grid-cols-2 gap-3" : ""}>
          <div><label className="label" htmlFor="fd">{f.kind === "camp" ? "First day" : "Date"}</label><input id="fd" type="date" className="field" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
          {f.kind === "camp" && <div><label className="label" htmlFor="fed">Last day</label><input id="fed" type="date" className="field" min={f.date} value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></div>}
        </div>
        {f.kind === "match" && <div><label className="label" htmlFor="fo">Opponent</label><input id="fo" className="field" value={f.opponent} onChange={(e) => setF({ ...f, opponent: e.target.value })} /></div>}
        {(f.kind === "tournament" || f.kind === "camp" || f.kind === "clinic") && <div><label className="label" htmlFor="ft">{f.kind === "camp" ? "Camp name (e.g. Summer Camp)" : f.kind === "clinic" ? "Clinic name" : "Tournament name"}</label><input id="ft" className="field" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>}
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="fs">Starts</label><input id="fs" type="time" className="field" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /><p className="mt-1 text-xs text-slate">{time12(f.startTime)}</p></div>
          <div><label className="label" htmlFor="fe">Ends</label><input id="fe" type="time" className="field" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} /><p className="mt-1 text-xs text-slate">{time12(f.endTime)}</p></div>
        </div>
        <div><label className="label" htmlFor="fl">Pitch / location</label><input id="fl" className="field" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></div>
        <div><label className="label" htmlFor="fk">Kit / dress code</label><input id="fk" className="field" value={f.dressCode} onChange={(e) => setF({ ...f, dressCode: e.target.value })} /></div>
        <div><label className="label" htmlFor="fv">Travel arrangements</label><textarea id="fv" className="field" rows={2} placeholder="e.g. Bus leaves the school gate at 8:15 AM" value={f.travelNotes} onChange={(e) => setF({ ...f, travelNotes: e.target.value })} /></div>
        {error && <Notice tone="bad">{error}</Notice>}
        <button className="btn-primary">Add fixture and tell parents</button>
      </form>
    </Modal>
  );
}

/** Field tab entry: choose today's / next session. */
export function FieldIndex() {
  const up = useUpcoming();
  const nav = useNavigate();
  const { pending } = useOffline();
  if (up.isLoading) return <Spinner />;
  if (up.error) return <ErrorNote error={up.error} />;
  const sessions = up.data!.filter((s) => !s.cancelled).slice(0, 8);
  return (
    <>
      <PageTitle banner title="Field check-in" sub="Works without signal. Changes sync when you're back online." />
      {pending.length > 0 && <Link to="/field/queue" className="sheet mb-4 flex items-center justify-between font-semibold text-warn">{pending.length} change{pending.length === 1 ? "" : "s"} waiting to sync <PendingBadge /></Link>}
      {sessions.length === 0 ? <Empty>No sessions coming up.</Empty> : (
        <ul className="grid gap-3">
          {sessions.map((s) => (
            <li key={s.id}>
              <button onClick={() => nav(`/s/${s.id}/field`)} className="sheet flex w-full items-center gap-3 text-left hover:ring-brand">
                <span className="w-1.5 self-stretch rounded-full" style={{ background: s.color }} aria-hidden />
                <div className="flex-1">
                  <p className="font-bold text-navy">{s.intramuralName}</p>
                  <p className="text-sm text-slate">{shortDate(s.date)} · {s.timeLabel}</p>
                </div>
                <Users className="h-5 w-5 text-slate" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function useIntramuralFromParam() {
  const { id } = useParams();
  return useIntramural(Number(id));
}
