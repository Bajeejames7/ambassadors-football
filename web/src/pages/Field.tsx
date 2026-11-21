import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CloudOff, Minus, Plus, RefreshCw, Search, Trash2, UserPlus } from "lucide-react";
import { cached, dismissFailed, enqueue, flush, useOffline, type Op } from "../lib/offline";
import { useIntramural } from "../lib/queries";
import { dateTime12, shortDate, titleCase } from "../lib/format";
import { api } from "../lib/api";
import { Empty, ErrorNote, NameInput, Notice, PageTitle, PendingBadge, SectionTitle, Spinner, Tabs } from "../components/ui";

type Status = "present" | "late" | "absent" | "excused";
interface RosterRow { playerId: number; firstName: string; lastName: string; category: string; team: string; status: Status | null }

/**
 * Field Mode: everything here works with no signal. Data comes from the copy
 * saved on the phone; every change goes into the phone's queue and syncs by itself.
 */
export function FieldCheckIn() {
  const sessionId = Number(useParams().id);
  const session = useQuery({ queryKey: ["session", sessionId], queryFn: () => cached<any>(`/sessions/${sessionId}`) });
  const intramural = useIntramural(session.data?.intramuralId ?? 0);
  const [tab, setTab] = useState<"roll" | "walkin" | "equipment" | "match">("roll");
  if (session.isLoading || (session.data && intramural.isLoading)) return <Spinner label="Opening field mode…" />;
  if (session.error) return <ErrorNote error={session.error} onRetry={() => session.refetch()} />;
  if (!intramural.data) return <ErrorNote error={intramural.error ?? new Error("Open this session once with signal so it is saved on your phone.")} />;
  const s = session.data;
  const i = intramural.data;
  const perms = i.myPermissions;
  const tabs = [
    { id: "roll" as const, label: "Roll call" },
    ...(perms.includes("players.register") ? [{ id: "walkin" as const, label: "Walk-in" }] : []),
    ...(perms.includes("equipment.check") ? [{ id: "equipment" as const, label: "Equipment" }] : []),
    { id: "match" as const, label: "Scores & welfare" },
  ];
  return (
    <>
      <PageTitle banner title="Field check-in" sub={<>{i.name} · {shortDate(s.date)} · {s.timeLabel}</>} action={<OfflineChip />} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "roll" && <RollCall sessionId={sessionId} intramuralId={i.id} canTake={perms.includes("attendance.take")} teams={i.teams} />}
      {tab === "walkin" && <WalkIn sessionId={sessionId} intramural={i} onDone={() => setTab("roll")} />}
      {tab === "equipment" && <Equipment sessionId={sessionId} />}
      {tab === "match" && <MatchAndWelfare sessionId={sessionId} intramural={i} />}
    </>
  );
}

function OfflineChip() {
  const { online } = useOffline();
  return online ? null : <span className="chip bg-warn text-navy"><CloudOff className="h-3.5 w-3.5" /> Offline</span>;
}

/** Pending attendance in the queue for this session: playerId → latest status. */
function usePendingAttendance(sessionId: number) {
  const { pending } = useOffline();
  return useMemo(() => {
    const map = new Map<number, Status>();
    for (const op of pending) {
      if (op.type !== "attendance" || op.payload.sessionId !== sessionId) continue;
      for (const e of op.payload.entries) map.set(e.playerId, e.status);
    }
    return map;
  }, [pending, sessionId]);
}

function RollCall({ sessionId, intramuralId, canTake, teams }: { sessionId: number; intramuralId: number; canTake: boolean; teams: { id: string; name: string }[] }) {
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  const roll = useQuery({ queryKey: ["attendance", sessionId], queryFn: () => cached<{ canTake: boolean; entries: RosterRow[] }>(`/sessions/${sessionId}/attendance`) });
  const pending = usePendingAttendance(sessionId);
  const { pending: queue } = useOffline();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  if (roll.isLoading) return <Spinner label="Loading the roster…" />;
  if (roll.error) return <ErrorNote error={roll.error} onRetry={() => roll.refetch()} />;
  const entries = roll.data!.entries;
  const walkIns = queue.filter((o) => o.type === "walk_in" && o.payload.intramuralId === intramuralId && o.payload.checkIn?.sessionId === sessionId);
  const categories = [...new Set(entries.map((e) => e.category).filter(Boolean))].sort((a, b) => (parseInt(a.replace(/\D/g, "")) || 0) - (parseInt(b.replace(/\D/g, "")) || 0));
  const shown = entries.filter((e) =>
    (!category || e.category === category) && `${e.firstName} ${e.lastName}`.toLowerCase().includes(q.trim().toLowerCase()));
  const statusOf = (e: RosterRow) => pending.get(e.playerId) ?? e.status;
  const here = entries.filter((e) => ["present", "late"].includes(statusOf(e) ?? "")).length + walkIns.length;

  const mark = (e: RosterRow, status: Status) => {
    if (!canTake) return;
    void enqueue("attendance", { sessionId, entries: [{ playerId: e.playerId, status, recordedAt: new Date().toISOString() }] }, `${e.firstName} ${e.lastName}: ${status}`);
  };
  const markRest = () => {
    const rest = entries.filter((e) => !statusOf(e));
    if (!rest.length) return;
    const at = new Date().toISOString();
    void enqueue("attendance", { sessionId, entries: rest.map((e) => ({ playerId: e.playerId, status: "absent", recordedAt: at })) }, `${rest.length} marked absent`);
  };

  return (
    <>
      <div className="sticky top-14 z-10 -mx-4 bg-page/95 px-4 pb-3 pt-1 backdrop-blur md:top-0">
        <div className="flex items-baseline justify-between">
          <p className="display text-[2.4rem] text-navy">{here}<span className="text-slate"> / {entries.length + walkIns.length}</span></p>
          <p className="text-sm font-semibold text-slate">checked in</p>
        </div>
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-3 top-3 h-5 w-5 text-slate" aria-hidden />
          <input className="field pl-10" placeholder="Search the roster" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the roster" />
        </div>
        {categories.length > 1 && (
          <div className="mt-2 flex gap-1 overflow-x-auto">
            {["", ...categories].map((c) => (
              <button key={c || "all"} onClick={() => setCategory(c)} className={`whitespace-nowrap rounded-full px-3 py-1 text-sm font-semibold ${category === c ? "bg-navy text-white" : "bg-white ring-1 ring-line"}`}>{c || "All"}</button>
            ))}
          </div>
        )}
      </div>
      {!canTake && <p className="mb-3 rounded-xl bg-white p-3 text-sm text-slate ring-1 ring-line">You can view the roll call. Ask your coordinator for the attendance privilege to mark players.</p>}
      {roll.data!.__offline && <p className="mb-3 text-sm font-semibold text-warn">Roster saved {dateTime12(new Date(roll.data!.__offline as unknown as number).toISOString())}.</p>}
      {entries.length === 0 && walkIns.length === 0 ? <Empty>No players registered yet.</Empty> : (
        <ul className="grid gap-2">
          {walkIns.map((o) => (
            <li key={o.id} className="sheet flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-full bg-good text-white" aria-hidden>✓</span>
              <div className="flex-1"><p className="font-bold">{titleCase(`${o.payload.firstName} ${o.payload.lastName}`)}</p><p className="text-sm text-slate">Walk-in · {o.payload.category || "No category"}</p></div>
              <PendingBadge />
            </li>
          ))}
          {shown.map((e) => {
            const st = statusOf(e);
            const isPending = pending.has(e.playerId);
            return (
              <li key={e.playerId} className="sheet p-3">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => mark(e, st === "present" ? "absent" : "present")}
                    disabled={!canTake}
                    aria-label={`${e.firstName} ${e.lastName}: ${st ?? "not marked"}. Tap to mark ${st === "present" ? "absent" : "present"}.`}
                    className={`grid h-12 w-12 shrink-0 place-items-center rounded-full text-lg font-bold ring-2 transition ${st === "present" ? "bg-good text-white ring-good" : st === "late" ? "bg-warn text-white ring-warn" : st === "absent" ? "bg-white text-bad ring-bad/40" : "bg-white text-slate ring-line"}`}
                  >
                    {st === "present" ? "✓" : st === "late" ? "L" : st === "absent" ? "✕" : e.firstName[0]}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[16px] font-bold text-navy">{e.firstName} {e.lastName}</p>
                    <p className="text-sm text-slate">{[e.category, teamName(e.team)].filter(Boolean).join(" · ") || "—"}</p>
                  </div>
                  {isPending && <PendingBadge />}
                </div>
                {canTake && (
                  <div className="mt-2 flex gap-1 pl-[3.75rem]">
                    {(["late", "absent", "excused"] as const).map((x) => (
                      <button key={x} onClick={() => mark(e, x)} className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${st === x ? "bg-navy text-white ring-navy" : "ring-line text-slate"}`}>
                        {x[0].toUpperCase() + x.slice(1)}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {canTake && entries.some((e) => !statusOf(e)) && (
        <button className="btn-ghost mt-4 w-full" onClick={markRest}>Mark everyone not checked in as absent</button>
      )}
    </>
  );
}

function WalkIn({ sessionId, intramural, onDone }: { sessionId: number; intramural: { id: number; categories: string[]; airtable?: any }; onDone: () => void }) {
  const { online } = useOffline();
  const [f, setF] = useState({ firstName: "", lastName: "", category: intramural.categories[0] ?? "", guardianName: "", guardianPhone: "", guardianEmail: "", medicalNotes: "" });
  const [done, setDone] = useState("");
  const [airQ, setAirQ] = useState("");
  const [airResults, setAirResults] = useState<any[] | null>(null);
  const [airError, setAirError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await enqueue("walk_in", { ...f, intramuralId: intramural.id, walkIn: true, checkIn: { sessionId, status: "present", recordedAt: new Date().toISOString() } }, `Walk-in: ${titleCase(`${f.firstName} ${f.lastName}`)}`);
    setDone(`${titleCase(f.firstName)} is registered and checked in${online ? "" : " on this phone; it syncs when you're back online"}.`);
    setF({ ...f, firstName: "", lastName: "", guardianName: "", guardianPhone: "", guardianEmail: "", medicalNotes: "" });
  };
  const searchAirtable = async (e: React.FormEvent) => {
    e.preventDefault();
    setAirError("");
    try {
      setAirResults(await api(`/intramurals/${intramural.id}/airtable/search?q=${encodeURIComponent(airQ)}`));
    } catch (err) {
      setAirError((err as Error).message);
    }
  };
  const importRecord = async (recordId: string) => {
    try {
      const r = await api<{ id: number }>(`/intramurals/${intramural.id}/airtable/import`, { method: "POST", body: { recordId } });
      await enqueue("attendance", { sessionId, entries: [{ playerId: r.id, status: "present", recordedAt: new Date().toISOString() }] }, "Imported player checked in");
      setDone("Imported from Airtable and checked in.");
      setAirResults(null);
      onDone();
    } catch (err) {
      setAirError((err as Error).message);
    }
  };
  return (
    <>
      {intramural.airtable?.searchEnabled && (
        <form onSubmit={searchAirtable} className="sheet mb-4">
          <label className="label" htmlFor="aq">Already registered on the school's form?</label>
          <div className="flex gap-2">
            <input id="aq" className="field" placeholder="Search Airtable by name" value={airQ} onChange={(e) => setAirQ(e.target.value)} disabled={!online} />
            <button className="btn-blue" disabled={!online || airQ.trim().length < 2}>Search</button>
          </div>
          {!online && <p className="mt-1 text-xs text-slate">Airtable search needs signal. Register them below instead.</p>}
          {airError && <Notice tone="bad">{airError}</Notice>}
          {airResults && (
            <ul className="mt-3 divide-y divide-line">
              {airResults.length === 0 && <li className="py-2 text-sm text-slate">No match on the form.</li>}
              {airResults.map((r) => (
                <li key={r.recordId} className="flex items-center justify-between gap-2 py-2">
                  <span><span className="font-semibold">{r.firstName} {r.lastName}</span> <span className="text-sm text-slate">{r.category}</span></span>
                  {r.playerId ? <span className="text-sm text-slate">Already on roster</span> : <button className="btn-ghost min-h-9" onClick={() => importRecord(r.recordId)}>Add & check in</button>}
                </li>
              ))}
            </ul>
          )}
        </form>
      )}
      <form onSubmit={submit} className="sheet grid gap-3">
        <h2 className="condensed text-lg text-navy">Register a walk-in player</h2>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="wf">First name</label><NameInput id="wf" value={f.firstName} onChange={(v) => setF({ ...f, firstName: v })} required autoComplete="off" /></div>
          <div><label className="label" htmlFor="wl">Last name</label><NameInput id="wl" value={f.lastName} onChange={(v) => setF({ ...f, lastName: v })} autoComplete="off" /></div>
        </div>
        <div>
          <label className="label" htmlFor="wc">Age group</label>
          <select id="wc" className="field" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
            {intramural.categories.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div><label className="label" htmlFor="wg">Parent or guardian</label><NameInput id="wg" value={f.guardianName} onChange={(v) => setF({ ...f, guardianName: v })} autoComplete="off" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="wp">Parent phone</label><input id="wp" className="field" type="tel" value={f.guardianPhone} onChange={(e) => setF({ ...f, guardianPhone: e.target.value })} /></div>
          <div><label className="label" htmlFor="we">Parent email</label><input id="we" className="field" type="email" value={f.guardianEmail} onChange={(e) => setF({ ...f, guardianEmail: e.target.value })} /></div>
        </div>
        <div><label className="label" htmlFor="wm">Allergies or medical notes</label><textarea id="wm" className="field" rows={2} value={f.medicalNotes} onChange={(e) => setF({ ...f, medicalNotes: e.target.value })} /></div>
        <p className="text-xs text-slate">The parent can sign up with this phone or email to follow their child.</p>
        {done && <Notice tone="good">{done}</Notice>}
        <button className="btn-primary h-12"><UserPlus className="h-4 w-4" /> Register and check in</button>
      </form>
    </>
  );
}

function Equipment({ sessionId }: { sessionId: number }) {
  const q = useQuery({ queryKey: ["equipment", sessionId], queryFn: () => cached<{ items: { id: number; name: string; expected: number }[]; checks: any[] }>(`/sessions/${sessionId}/equipment`) });
  const { pending } = useOffline();
  const [phase, setPhase] = useState<"before" | "after">("before");
  const [counts, setCounts] = useState<Record<string, Record<number, { counted: number; condition: string }>>>({});
  const [notes, setNotes] = useState("");
  const [saved, setSaved] = useState("");
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { items, checks } = q.data!;
  const existing = checks.find((c) => c.phase === phase);
  const pendingCheck = [...pending].reverse().find((o) => o.type === "equipment" && o.payload.sessionId === sessionId && o.payload.phase === phase);
  const valueOf = (id: number, expected: number) => {
    const local = counts[phase]?.[id];
    if (local) return local;
    const fromPending = pendingCheck?.payload.items.find((x: any) => x.itemId === id);
    if (fromPending) return fromPending;
    const fromServer = existing?.items.find((x: any) => x.itemId === id);
    return fromServer ?? { counted: phase === "after" ? (checks.find((c) => c.phase === "before")?.items.find((x: any) => x.itemId === id)?.counted ?? expected) : expected, condition: "good" };
  };
  const setItem = (id: number, v: { counted: number; condition: string }) => setCounts({ ...counts, [phase]: { ...(counts[phase] ?? {}), [id]: v } });
  const save = async () => {
    await enqueue("equipment", { sessionId, phase, notes, items: items.map((it) => ({ itemId: it.id, ...valueOf(it.id, it.expected) })) }, `Equipment ${phase} session`);
    setSaved(`${phase === "before" ? "Before" : "After"}-session count saved.`);
  };
  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-2">
        {(["before", "after"] as const).map((p) => (
          <button key={p} onClick={() => { setPhase(p); setSaved(""); }} className={`rounded-xl px-3 py-2.5 text-sm font-semibold ring-1 ${phase === p ? "bg-navy text-white ring-navy" : "bg-white ring-line"}`}>
            {p === "before" ? "Before session" : "After session"}
            {(checks.some((c) => c.phase === p) || pending.some((o) => o.type === "equipment" && o.payload.sessionId === sessionId && o.payload.phase === p)) && " ✓"}
          </button>
        ))}
      </div>
      {pendingCheck && <p className="mb-2"><PendingBadge /></p>}
      <ul className="sheet divide-y divide-line py-1">
        {items.map((it) => {
          const v = valueOf(it.id, it.expected);
          const short = v.counted < it.expected;
          return (
            <li key={it.id} className="py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-navy">{it.name}</p>
                  <p className={`text-sm ${short ? "font-semibold text-bad" : "text-slate"}`}>{short ? `${it.expected - v.counted} short of ${it.expected}` : `Expected ${it.expected}`}</p>
                </div>
                <button className="grid h-10 w-10 place-items-center rounded-full ring-1 ring-line" aria-label={`One fewer ${it.name}`} onClick={() => setItem(it.id, { ...v, counted: Math.max(0, v.counted - 1) })}><Minus className="h-4 w-4" /></button>
                <span className="display w-10 text-center text-2xl" aria-live="polite">{v.counted}</span>
                <button className="grid h-10 w-10 place-items-center rounded-full ring-1 ring-line" aria-label={`One more ${it.name}`} onClick={() => setItem(it.id, { ...v, counted: v.counted + 1 })}><Plus className="h-4 w-4" /></button>
              </div>
              <div className="mt-2 flex gap-1">
                {(["good", "damaged", "missing"] as const).map((c) => (
                  <button key={c} onClick={() => setItem(it.id, { ...v, condition: c })} className={`rounded-full px-3 py-1 text-xs font-semibold ring-1 ${v.condition === c ? "bg-navy text-white ring-navy" : "text-slate ring-line"}`}>{c[0].toUpperCase() + c.slice(1)}</button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      <label className="label mt-3" htmlFor="eqn">Notes</label>
      <textarea id="eqn" className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. one ball punctured" />
      {saved && <Notice tone="good">{saved}</Notice>}
      <button className="btn-primary mt-3 h-12 w-full" onClick={save}>Save {phase}-session count</button>
    </>
  );
}

function MatchAndWelfare({ sessionId, intramural }: { sessionId: number; intramural: { id: number; teams: { id: string; name: string; color: string }[]; categories: string[] } }) {
  const roll = useQuery({ queryKey: ["attendance", sessionId], queryFn: () => cached<{ entries: RosterRow[] }>(`/sessions/${sessionId}/attendance`) });
  const [m, setM] = useState({ team: intramural.teams[0]?.name ?? "", opponent: intramural.teams[1]?.name ?? "", points: 0, opponentPoints: 0, category: intramural.categories[0] ?? "" });
  const [j, setJ] = useState({ playerId: 0, severity: "knock", bodyPart: "", description: "", actionTaken: "" });
  const [msg, setMsg] = useState("");
  const saveMatch = async (e: React.FormEvent) => {
    e.preventDefault();
    await enqueue("tally", { intramuralId: intramural.id, sessionId, kind: "match", ...m }, `Score ${m.team} ${m.points}–${m.opponentPoints} ${m.opponent}`);
    setMsg("Score saved.");
    setM({ ...m, points: 0, opponentPoints: 0 });
  };
  const point = async (teamId: string, kind: "virtue_points" | "sportsmanship") => {
    await enqueue("tally", { intramuralId: intramural.id, sessionId, kind, team: teamId, points: 1 }, `+1 ${kind === "sportsmanship" ? "sportsmanship" : "point"} for ${teamId}`);
    setMsg("Point added.");
  };
  const saveInjury = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!j.playerId) return;
    const p = roll.data?.entries.find((x) => x.playerId === j.playerId);
    await enqueue("injury", { ...j, sessionId }, `Injury: ${p?.firstName ?? "player"}`);
    setMsg("Injury reported. The parents are alerted as soon as this syncs.");
    setJ({ playerId: 0, severity: "knock", bodyPart: "", description: "", actionTaken: "" });
  };
  const score = (key: "points" | "opponentPoints", label: string) => (
    <div className="text-center">
      <p className="text-xs font-semibold text-slate">{label}</p>
      <div className="mt-1 flex items-center justify-center gap-2">
        <button type="button" className="grid h-10 w-10 place-items-center rounded-full ring-1 ring-line" aria-label={`${label} minus one`} onClick={() => setM({ ...m, [key]: Math.max(0, m[key] - 1) })}><Minus className="h-4 w-4" /></button>
        <span className="display w-12 text-[2.6rem] text-navy">{m[key]}</span>
        <button type="button" className="grid h-10 w-10 place-items-center rounded-full ring-1 ring-line" aria-label={`${label} plus one`} onClick={() => setM({ ...m, [key]: m[key] + 1 })}><Plus className="h-4 w-4" /></button>
      </div>
    </div>
  );
  return (
    <>
      {msg && <Notice tone="good">{msg}</Notice>}
      <form onSubmit={saveMatch} className="sheet mt-2 grid gap-3">
        <h2 className="condensed text-lg text-navy">Small-sided match score</h2>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="mh">Home</label><input id="mh" className="field" value={m.team} onChange={(e) => setM({ ...m, team: e.target.value })} required /></div>
          <div><label className="label" htmlFor="ma">Away</label><input id="ma" className="field" value={m.opponent} onChange={(e) => setM({ ...m, opponent: e.target.value })} required /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">{score("points", m.team || "Home")}{score("opponentPoints", m.opponent || "Away")}</div>
        {intramural.categories.length > 0 && (
          <select className="field" value={m.category} onChange={(e) => setM({ ...m, category: e.target.value })} aria-label="Age group">
            {intramural.categories.map((c) => <option key={c}>{c}</option>)}
          </select>
        )}
        <button className="btn-primary">Save score</button>
      </form>

      {intramural.teams.length > 0 && (
        <>
          <SectionTitle>Virtue team points</SectionTitle>
          <div className="grid grid-cols-2 gap-2">
            {intramural.teams.map((t) => (
              <div key={t.id} className="sheet p-3">
                <p className="flex items-center gap-2 font-bold text-navy"><span className="h-3 w-3 rounded-full" style={{ background: t.color }} aria-hidden />{t.name}</p>
                <div className="mt-2 flex gap-1">
                  <button className="btn-ghost min-h-9 flex-1 px-2 text-xs" onClick={() => point(t.id, "virtue_points")}>+1 point</button>
                  <button className="btn-ghost min-h-9 flex-1 px-2 text-xs" onClick={() => point(t.id, "sportsmanship")}>+1 fair play</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <SectionTitle>Report an injury or knock</SectionTitle>
      <form onSubmit={saveInjury} className="sheet grid gap-3">
        <div>
          <label className="label" htmlFor="ip">Player</label>
          <select id="ip" className="field" value={j.playerId} onChange={(e) => setJ({ ...j, playerId: Number(e.target.value) })} required>
            <option value={0}>Choose a player</option>
            {(roll.data?.entries ?? []).map((p) => <option key={p.playerId} value={p.playerId}>{p.firstName} {p.lastName}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-4 gap-1">
          {(["knock", "minor", "moderate", "serious"] as const).map((sv) => (
            <button type="button" key={sv} onClick={() => setJ({ ...j, severity: sv })} className={`rounded-lg px-1 py-2 text-xs font-semibold ring-1 ${j.severity === sv ? (sv === "serious" || sv === "moderate" ? "bg-bad text-white ring-bad" : "bg-navy text-white ring-navy") : "ring-line"}`}>
              {sv[0].toUpperCase() + sv.slice(1)}
            </button>
          ))}
        </div>
        <div><label className="label" htmlFor="ib">Where</label><input id="ib" className="field" placeholder="e.g. left ankle" value={j.bodyPart} onChange={(e) => setJ({ ...j, bodyPart: e.target.value })} /></div>
        <div><label className="label" htmlFor="idd">What happened</label><textarea id="idd" className="field" rows={2} required minLength={3} value={j.description} onChange={(e) => setJ({ ...j, description: e.target.value })} /></div>
        <div><label className="label" htmlFor="ia">What you did</label><input id="ia" className="field" placeholder="e.g. ice, rested for 10 minutes" value={j.actionTaken} onChange={(e) => setJ({ ...j, actionTaken: e.target.value })} /></div>
        <button className="btn-danger">Report and alert parents</button>
      </form>
    </>
  );
}

/** Everything waiting to sync, and anything the server refused. */
export function QueuePage() {
  const { pending, failed, online, syncing } = useOffline();
  return (
    <>
      <PageTitle banner title="Pending sync" sub={online ? "These changes are being sent now." : "You're offline. These changes are saved on this phone and send themselves when you're back online."}
        action={<button className="btn-ghost" onClick={() => void flush()} disabled={!online || syncing}><RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} /> Sync now</button>} />
      {pending.length === 0 ? <Empty>Everything is synced.</Empty> : (
        <ul className="sheet divide-y divide-line py-1">
          {pending.map((o: Op) => (
            <li key={o.id} className="flex items-center justify-between gap-3 py-2.5">
              <span className="text-[15px]">{o.label}</span>
              <span className="text-xs text-slate">{dateTime12(new Date(o.createdAt).toISOString())}</span>
            </li>
          ))}
        </ul>
      )}
      {failed.length > 0 && (
        <>
          <SectionTitle action={<button className="text-sm font-semibold text-brand" onClick={() => void dismissFailed()}>Clear all</button>}>Not saved</SectionTitle>
          <ul className="grid gap-2">
            {failed.map((o) => (
              <li key={o.id} className="sheet flex items-start gap-3 ring-bad/30">
                <div className="flex-1">
                  <p className="font-semibold">{o.label}</p>
                  <p className="text-sm text-bad">{o.error}</p>
                </div>
                <button aria-label="Dismiss" onClick={() => void dismissFailed(o.id)} className="p-1 text-slate"><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-6 text-sm text-slate"><Link to="/field" className="font-semibold text-brand">Back to field check-in</Link></p>
    </>
  );
}
