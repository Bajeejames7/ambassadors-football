import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Award, BookOpen, ChevronRight, Search } from "lucide-react";
import { api } from "../lib/api";
import { cached, enqueue, useOffline } from "../lib/offline";
import { useIntramural, type Intramural } from "../lib/queries";
import { dateTime12, shortDate, VIRTUE_LABELS, WEEKDAYS } from "../lib/format";
import { Crest, Empty, ErrorNote, Modal, NameInput, Notice, PageTitle, PendingBadge, SectionTitle, Spinner, Tabs } from "../components/ui";
import { SessionsTab } from "./Staff";
import { PaymentsTab, PeopleTab, SetupTab } from "./Admin";
import { VirtueRadar } from "../components/VirtueRadar";
import { StatusChip } from "./Parent";
import { CoachPlayersTab, ReportsTab } from "./CoachPlayers";
import { ageGroupFor } from "../lib/format";

type Tab = "sessions" | "players" | "reports" | "mentorship" | "tally" | "payments" | "people" | "setup";

export function IntramuralHub() {
  const { id, tab } = useParams();
  const nav = useNavigate();
  const q = useIntramural(Number(id));
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />;
  const i = q.data!;
  const p = i.myPermissions;
  const tabs: { id: Tab; label: string }[] = [
    { id: "sessions", label: "Sessions" },
    { id: "players", label: "Players" },
    { id: "reports", label: "Reports" },
    { id: "mentorship", label: "Mentorship" },
    { id: "tally", label: i.programMode === "school" ? "Virtue Teams & awards" : "Scores & awards" },
    ...(p.includes("payments.manage") ? [{ id: "payments" as Tab, label: "Payments" }] : []),
    ...(p.includes("roles.assign") || p.includes("parents.approve") || p.includes("privileges.grant") ? [{ id: "people" as Tab, label: "People" }] : []),
    ...(p.includes("schedules.edit") || p.includes("airtable.manage") ? [{ id: "setup" as Tab, label: "Setup" }] : []),
  ];
  const current = (tabs.find((t) => t.id === tab)?.id ?? "sessions") as Tab;
  return (
    <>
      <div className="photo-navy mb-5 flex items-center gap-3 rounded-[26px] px-4 pb-4 pt-8 text-white">
        <Crest i={i} size={52} />
        <div className="min-w-0">
          <h1 className="display truncate text-[2rem]">{i.name}</h1>
          <p className="text-sm text-white/80">
            {i.programMode === "school" ? "School · 4 Virtue Teams" : "Club · events & camps"} · {WEEKDAYS[i.sessionWeekday]}s · {i.countryName}
            {i.myAgeGroups && i.myAgeGroups.length > 0 ? ` · You coach ${i.myAgeGroups.join(", ")}` : ""}
          </p>
        </div>
      </div>
      <Tabs tabs={tabs} value={current} onChange={(t) => nav(`/i/${i.id}/${t}`, { replace: true })} />
      {current === "sessions" && <SessionsTab i={i} />}
      {current === "players" && <PlayersTab i={i} />}
      {current === "reports" && <ReportsTab i={i} />}
      {current === "mentorship" && <MentorshipTab i={i} />}
      {current === "tally" && <TallyTab i={i} />}
      {current === "payments" && <PaymentsTab i={i} />}
      {current === "people" && <PeopleTab i={i} />}
      {current === "setup" && <SetupTab i={i} />}
    </>
  );
}

function PlayersTab({ i }: { i: Intramural }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  return (
    <>
      <CoachPlayersTab i={i} onAddPlayer={i.myPermissions.includes("players.register") ? () => setAdding(true) : undefined} />
      {adding && <AddPlayer i={i} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void qc.invalidateQueries({ queryKey: ["players", i.id] }); }} />}
    </>
  );
}

function AddPlayer({ i, onClose, onSaved }: { i: Intramural; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ firstName: "", lastName: "", dateOfBirth: "", birthYear: "", category: "", team: "", guardianName: "", guardianEmail: "", guardianPhone: "", medicalNotes: "" });
  const thisYear = new Date().getFullYear();
  const [error, setError] = useState("");
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(`/intramurals/${i.id}/players`, { method: "POST", body: { ...f, dateOfBirth: f.dateOfBirth || null, birthYear: f.birthYear ? Number(f.birthYear) : null } });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal open onClose={onClose} title="Register a player">
      <form onSubmit={save} className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="pf">First name</label><NameInput id="pf" value={f.firstName} onChange={(v) => setF({ ...f, firstName: v })} required autoComplete="off" /></div>
          <div><label className="label" htmlFor="pl">Last name</label><NameInput id="pl" value={f.lastName} onChange={(v) => setF({ ...f, lastName: v })} autoComplete="off" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="py">Birth year</label>
            <select id="py" className="field" value={f.birthYear} onChange={(e) => setF({ ...f, birthYear: e.target.value, category: e.target.value ? ageGroupFor(Number(e.target.value)) : f.category })}>
              <option value="">Choose</option>
              {Array.from({ length: 16 }, (_, k) => thisYear - 3 - k).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div><label className="label" htmlFor="pc">Age group</label><select id="pc" className="field" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">From birth year</option>{i.categories.map((c) => <option key={c}>{c}</option>)}</select></div>
        </div>
        {i.teams.length > 0 && <div><label className="label" htmlFor="pt">Virtue team</label><select id="pt" className="field" value={f.team} onChange={(e) => setF({ ...f, team: e.target.value })}><option value="">None</option>{i.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>}
        <div><label className="label" htmlFor="pg">Parent or guardian</label><NameInput id="pg" value={f.guardianName} onChange={(v) => setF({ ...f, guardianName: v })} autoComplete="off" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="pp">Parent phone</label><input id="pp" className="field" type="tel" value={f.guardianPhone} onChange={(e) => setF({ ...f, guardianPhone: e.target.value })} /></div>
          <div><label className="label" htmlFor="pe">Parent email</label><input id="pe" className="field" type="email" value={f.guardianEmail} onChange={(e) => setF({ ...f, guardianEmail: e.target.value })} /></div>
        </div>
        <div><label className="label" htmlFor="pd">Date of birth (optional)</label><input id="pd" type="date" className="field" value={f.dateOfBirth} onChange={(e) => setF({ ...f, dateOfBirth: e.target.value, birthYear: e.target.value ? e.target.value.slice(0, 4) : f.birthYear, category: e.target.value ? ageGroupFor(Number(e.target.value.slice(0, 4))) : f.category })} /></div>
        <div><label className="label" htmlFor="pm">Allergies or medical notes</label><textarea id="pm" className="field" rows={2} value={f.medicalNotes} onChange={(e) => setF({ ...f, medicalNotes: e.target.value })} /></div>
        {error && <Notice tone="bad">{error}</Notice>}
        <button className="btn-primary">Register player</button>
      </form>
    </Modal>
  );
}

/** One player, as coaches see them: progress plus quick feedback, virtue scores and awards. */
export function PlayerPage() {
  const id = Number(useParams().id);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["progress", id], queryFn: () => cached<any>(`/players/${id}/progress`) });
  const intramural = useIntramural(q.data?.player.intramuralId ?? 0);
  const [msg, setMsg] = useState("");
  const [fb, setFb] = useState({ category: "Teamwork", rating: 4, note: "", visibleToParent: true });
  const [scores, setScores] = useState<Record<string, number>>({});
  const [award, setAward] = useState({ award: "", virtue: "", reason: "" });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const p = q.data;
  const pl = p.player;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["progress", id] });
  const sendFeedback = async (e: React.FormEvent) => {
    e.preventDefault();
    await api(`/players/${id}/feedback`, { method: "POST", body: fb });
    setFb({ ...fb, note: "" });
    setMsg("Feedback saved.");
    refresh();
  };
  const sendScores = async () => {
    await api(`/players/${id}/virtues`, { method: "POST", body: { scores } });
    setScores({});
    setMsg("Virtue scores saved.");
    refresh();
  };
  const sendAward = async (e: React.FormEvent) => {
    e.preventDefault();
    await api(`/intramurals/${pl.intramuralId}/awards`, { method: "POST", body: { playerId: id, ...award } });
    setAward({ award: "", virtue: "", reason: "" });
    setMsg("Award given. The parents are told.");
    refresh();
  };
  return (
    <>
      <PageTitle title={`${pl.firstName} ${pl.lastName}`} sub={[pl.intramuralName, pl.category, pl.team].filter(Boolean).join(" · ")} />
      {msg && <Notice tone="good">{msg}</Notice>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sheet">
          <p className="text-sm font-semibold text-slate">Attendance this season</p>
          <p className="display mt-1 text-[2.6rem] text-navy">{p.attendance.rate == null ? "—" : `${p.attendance.rate}%`}</p>
          <p className="text-sm text-slate">{p.attendance.attended} of {p.attendance.recorded}</p>
        </div>
        <div className="sheet text-[15px]">
          <p className="text-sm font-semibold text-slate">Parent or guardian</p>
          <p className="mt-1 font-bold">{pl.guardianName || "—"}</p>
          {pl.guardianPhone && <a className="block text-brand" href={`tel:${pl.guardianPhone}`}>{pl.guardianPhone}</a>}
          {pl.guardianEmail && <a className="block text-brand" href={`mailto:${pl.guardianEmail}`}>{pl.guardianEmail}</a>}
          {pl.medicalNotes && <p className="mt-2 rounded-lg bg-bad/10 p-2 text-sm text-bad">Medical: {pl.medicalNotes}</p>}
        </div>
      </div>

      <SectionTitle>Virtues</SectionTitle>
      <div className="sheet">
        <VirtueRadar data={p.virtues} />
        <p className="label mt-2">Score today (1–10)</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Object.entries(VIRTUE_LABELS).map(([k, label]) => (
            <label key={k} className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 ring-1 ring-line">
              <span className="text-sm font-semibold">{label}</span>
              <select className="rounded-md bg-page px-1 py-1 text-sm" value={scores[k] ?? ""} onChange={(e) => setScores({ ...scores, [k]: Number(e.target.value) })}>
                <option value="">–</option>
                {Array.from({ length: 10 }, (_, n) => <option key={n + 1}>{n + 1}</option>)}
              </select>
            </label>
          ))}
        </div>
        <button className="btn-primary mt-3" disabled={!Object.keys(scores).length} onClick={sendScores}>Save scores</button>
      </div>

      <SectionTitle>Feedback for the parents</SectionTitle>
      <form onSubmit={sendFeedback} className="sheet grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="fc">Category</label>
            <select id="fc" className="field" value={fb.category} onChange={(e) => setFb({ ...fb, category: e.target.value })}>
              {["Technical", "Teamwork", "Attitude", "Fitness", "Leadership", "Faith & character"].map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="fr">Rating</label>
            <select id="fr" className="field" value={fb.rating} onChange={(e) => setFb({ ...fb, rating: Number(e.target.value) })}>
              {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} of 5</option>)}
            </select>
          </div>
        </div>
        <textarea className="field" rows={2} aria-label="Note" placeholder="What did you see today?" value={fb.note} onChange={(e) => setFb({ ...fb, note: e.target.value })} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={fb.visibleToParent} onChange={(e) => setFb({ ...fb, visibleToParent: e.target.checked })} /> Parents can see this</label>
        <button className="btn-primary justify-self-start">Save feedback</button>
      </form>

      <SectionTitle>Weekly character award</SectionTitle>
      <form onSubmit={sendAward} className="sheet grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="aw">Award</label><input id="aw" className="field" placeholder="e.g. Fortitude Award" value={award.award} onChange={(e) => setAward({ ...award, award: e.target.value })} required /></div>
          <div><label className="label" htmlFor="av">Virtue</label><select id="av" className="field" value={award.virtue} onChange={(e) => setAward({ ...award, virtue: e.target.value })}><option value="">—</option>{Object.entries(VIRTUE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        </div>
        <input className="field" aria-label="Reason" placeholder="Why? Parents will read this." value={award.reason} onChange={(e) => setAward({ ...award, reason: e.target.value })} />
        <button className="btn-blue justify-self-start"><Award className="h-4 w-4" /> Give award</button>
      </form>

      <SectionTitle>History</SectionTitle>
      <ul className="sheet divide-y divide-line py-1">
        {p.attendance.history.slice(0, 8).map((h: any) => (
          <li key={h.sessionId} className="flex items-center justify-between py-2"><span>{shortDate(h.date)}</span><StatusChip status={h.status} at={h.checkedInAt} /></li>
        ))}
        {p.attendance.history.length === 0 && <li className="py-3 text-slate">No sessions recorded yet.</li>}
      </ul>
      {p.injuries.length > 0 && (
        <>
          <SectionTitle>Injuries</SectionTitle>
          <ul className="grid gap-2">
            {p.injuries.map((j: any) => (
              <li key={j.id} className="sheet text-[15px]"><span className="font-bold">{j.severity}</span> · {j.bodyPart} — {j.description} <span className="text-sm text-slate">({dateTime12(j.createdAt)}{j.acknowledgedAt ? ", parent has seen it" : ""})</span></li>
            ))}
          </ul>
        </>
      )}
      {intramural.data && <p className="mt-6"><Link className="text-sm font-semibold text-brand" to={`/i/${pl.intramuralId}/players`}>Back to {intramural.data.name}</Link></p>}
    </>
  );
}

function MentorshipTab({ i }: { i: Intramural }) {
  const { pending } = useOffline();
  const q = useQuery({ queryKey: ["mentorship", i.id], queryFn: () => cached<any[]>(`/intramurals/${i.id}/mentorship`) });
  const players = useQuery({ queryKey: ["players", i.id], queryFn: () => cached<any[]>(`/intramurals/${i.id}/players`) });
  const sessions = useQuery({ queryKey: ["sessions", i.id], queryFn: () => cached<any[]>(`/intramurals/${i.id}/sessions`) });
  const today = new Date().toISOString().slice(0, 10);
  const recent = (sessions.data ?? []).filter((s) => s.date <= today).reverse();
  const [f, setF] = useState({ sessionId: 0, playerId: 0, discussionNotes: "", scripture: "", scriptureMilestone: "", prayerPoints: "", welfareObservation: "" });
  const [msg, setMsg] = useState("");
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    await enqueue("mentorship", { ...f, intramuralId: i.id, sessionId: f.sessionId || recent[0]?.id || null, playerId: f.playerId || null }, "Mentorship reflection");
    setMsg("Reflection saved.");
    setF({ ...f, discussionNotes: "", scripture: "", scriptureMilestone: "", prayerPoints: "", welfareObservation: "", playerId: 0 });
  };
  const queued = pending.filter((o) => o.type === "mentorship" && o.payload.intramuralId === i.id);
  return (
    <>
      <p className="mb-3 flex items-start gap-2 rounded-xl bg-white p-3 text-sm text-slate ring-1 ring-line">
        <BookOpen className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> Reflection logs are for coaches and coordinators. Parents never see them.
      </p>
      <form onSubmit={save} className="sheet grid gap-3">
        <h2 className="condensed text-lg text-navy">Post-practice reflection</h2>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="ms">Session</label>
            <select id="ms" className="field" value={f.sessionId} onChange={(e) => setF({ ...f, sessionId: Number(e.target.value) })}>
              <option value={0}>{recent[0] ? `Latest (${shortDate(recent[0].date)})` : "None"}</option>
              {recent.slice(1, 10).map((s) => <option key={s.id} value={s.id}>{shortDate(s.date)}</option>)}
            </select>
          </div>
          <div><label className="label" htmlFor="mp">About</label>
            <select id="mp" className="field" value={f.playerId} onChange={(e) => setF({ ...f, playerId: Number(e.target.value) })}>
              <option value={0}>The whole group</option>
              {(players.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
            </select>
          </div>
        </div>
        <div><label className="label" htmlFor="md">Discussion notes</label><textarea id="md" className="field" rows={3} value={f.discussionNotes} onChange={(e) => setF({ ...f, discussionNotes: e.target.value })} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="msc">Scripture</label><input id="msc" className="field" placeholder="e.g. Joshua 1:9" value={f.scripture} onChange={(e) => setF({ ...f, scripture: e.target.value })} /></div>
          <div><label className="label" htmlFor="mm">Milestone</label><input id="mm" className="field" placeholder="e.g. Memorised verse" value={f.scriptureMilestone} onChange={(e) => setF({ ...f, scriptureMilestone: e.target.value })} /></div>
        </div>
        <div><label className="label" htmlFor="mpp">Prayer points</label><textarea id="mpp" className="field" rows={2} value={f.prayerPoints} onChange={(e) => setF({ ...f, prayerPoints: e.target.value })} /></div>
        <div><label className="label" htmlFor="mw">Welfare observation</label><textarea id="mw" className="field" rows={2} value={f.welfareObservation} onChange={(e) => setF({ ...f, welfareObservation: e.target.value })} /></div>
        {msg && <Notice tone="good">{msg}</Notice>}
        <button className="btn-primary justify-self-start">Save reflection</button>
      </form>
      <SectionTitle>Recent reflections</SectionTitle>
      {queued.map((o) => <div key={o.id} className="sheet mb-2 flex items-center justify-between"><span className="text-[15px]">{o.payload.discussionNotes || o.payload.prayerPoints || "Reflection"}</span><PendingBadge /></div>)}
      {q.isLoading ? <Spinner /> : (q.data ?? []).length === 0 && !queued.length ? <Empty>No reflections yet.</Empty> : (
        <ul className="grid gap-2">
          {(q.data ?? []).map((m) => (
            <li key={m.id} className="sheet text-[15px]">
              <p className="text-sm text-slate">{m.coach} · {m.sessionDate ? shortDate(m.sessionDate) : dateTime12(m.createdAt)}{m.playerName ? ` · about ${m.playerName}` : ""}</p>
              {m.discussionNotes && <p className="mt-1">{m.discussionNotes}</p>}
              {m.scripture && <p className="mt-1"><span className="font-semibold">Scripture:</span> {m.scripture}{m.scriptureMilestone ? ` (${m.scriptureMilestone})` : ""}</p>}
              {m.prayerPoints && <p className="mt-1"><span className="font-semibold">Prayer:</span> {m.prayerPoints}</p>}
              {m.welfareObservation && <p className="mt-1"><span className="font-semibold">Welfare:</span> {m.welfareObservation}</p>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function TallyTab({ i }: { i: Intramural }) {
  const q = useQuery({ queryKey: ["tally", i.id], queryFn: () => cached<any>(`/intramurals/${i.id}/tally`) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const t = q.data;
  const max = Math.max(1, ...t.teams.map((x: any) => x.points));
  return (
    <>
      {t.teams.length > 0 && (
        <>
          <h2 className="condensed mb-2 text-lg text-navy">Virtue team standings</h2>
          <ul className="sheet grid gap-3">
            {[...t.teams].sort((a: any, b: any) => b.points - a.points).map((team: any) => (
              <li key={team.id}>
                <div className="flex justify-between text-[15px] font-semibold"><span>{team.name}</span><span className="display text-xl">{team.points}</span></div>
                <div className="mt-1 h-3 rounded-full bg-page"><div className="h-3 rounded-full" style={{ width: `${(team.points / max) * 100}%`, background: team.color }} /></div>
              </li>
            ))}
          </ul>
        </>
      )}
      <SectionTitle>Match results</SectionTitle>
      {t.matches.length === 0 ? <Empty>Scores entered in Field check-in appear here.</Empty> : (
        <ul className="sheet divide-y divide-line py-1">
          {t.matches.map((m: any) => (
            <li key={m.id} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 py-2.5 text-[15px]">
              <span className="truncate text-right font-semibold">{m.team}</span>
              <span className="display rounded-lg bg-navy px-2.5 py-1 text-lg text-white">{m.points}–{m.opponentPoints}</span>
              <span className="truncate font-semibold">{m.opponent}</span>
            </li>
          ))}
        </ul>
      )}
      {t.sportsmanship.length > 0 && (
        <>
          <SectionTitle>Sportsmanship points</SectionTitle>
          <ul className="sheet divide-y divide-line py-1">
            {t.sportsmanship.map((s: any) => <li key={s.team} className="flex justify-between py-2"><span>{i.teams.find((x) => x.id === s.team)?.name ?? s.team}</span><span className="font-bold">{s.points}</span></li>)}
          </ul>
        </>
      )}
      <SectionTitle>Character awards</SectionTitle>
      {t.awards.length === 0 ? <Empty>Give awards from a player's page.</Empty> : (
        <ul className="grid gap-2">
          {t.awards.map((a: any) => (
            <li key={a.id} className="sheet flex items-start gap-3">
              <Award className="h-5 w-5 shrink-0 text-warn" aria-hidden />
              <div><p className="font-bold">{a.playerName} — {a.award}</p><p className="text-sm text-slate">Week of {shortDate(a.weekOf)}{a.reason ? ` · ${a.reason}` : ""}</p></div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
