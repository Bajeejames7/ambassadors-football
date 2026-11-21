import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Phone, Send, ShieldAlert, UserPlus } from "lucide-react";
import { cached, enqueue, useOffline } from "../lib/offline";
import { type Intramural, type Session } from "../lib/queries";
import { AGE_GROUPS, dateRange, dateTime12, sessionLabel, today } from "../lib/format";
import { Empty, ErrorNote, Modal, Notice, PendingBadge, SectionTitle, Spinner } from "../components/ui";

type Status = "present" | "late" | "absent" | "excused";

interface Player {
  id: number;
  firstName: string;
  lastName: string;
  category: string;
  birthYear: number | null;
  medicalNotes: string;
  guardianName: string;
  guardianPhone: string;
}

/**
 * The coach's Players tab: their age groups at this school, one-tap
 * attendance with a live count, post-session feedback to the admins, and an
 * Emergency / Injury button on every player. Works offline: the roster and
 * the emergency numbers are saved on the phone, taps and reports sync later.
 */
export function CoachPlayersTab({ i, onAddPlayer }: { i: Intramural; onAddPlayer?: () => void }) {
  const mine = i.myAgeGroups ?? [];
  const [group, setGroup] = useState<string>(mine.length ? "mine" : "all");
  const roster = useQuery({ queryKey: ["players", i.id], queryFn: () => cached<Player[]>(`/intramurals/${i.id}/players`) });
  const sessions = useQuery({ queryKey: ["sessions", i.id], queryFn: () => cached<Session[]>(`/intramurals/${i.id}/sessions`) });
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [emergency, setEmergency] = useState<Player | null>(null);
  const [reporting, setReporting] = useState(false);

  // Today's session, else the most recent one, else the next.
  const sessionList = (sessions.data ?? []).filter((s) => !s.cancelled);
  const t = today();
  const defaultSession =
    sessionList.find((s) => s.date === t) ??
    [...sessionList].reverse().find((s) => s.date < t && s.date >= addDays(t, -3)) ??
    sessionList.find((s) => s.date > t) ??
    sessionList.at(-1);
  const current = sessionList.find((s) => s.id === sessionId) ?? defaultSession;

  if (roster.isLoading || sessions.isLoading) return <Spinner label="Loading your players…" />;
  if (roster.error) return <ErrorNote error={roster.error} onRetry={() => roster.refetch()} />;

  const groups = group === "mine" ? mine : group === "all" ? [] : [group];
  const players = roster.data!.filter((p) => groups.length === 0 || groups.includes(p.category));
  const groupLabel = group === "mine" ? mine.join(" & ") : group === "all" ? "all ages" : group;

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Age group">
        {mine.length > 0 && <Chip on={group === "mine"} onClick={() => setGroup("mine")}>My groups ({mine.join(", ")})</Chip>}
        <Chip on={group === "all"} onClick={() => setGroup("all")}>All</Chip>
        {AGE_GROUPS.map((g) => <Chip key={g} on={group === g} onClick={() => setGroup(g)}>{g}</Chip>)}
      </div>
      {current ? (
        <div className="mb-3">
          <label className="label" htmlFor="ps">Session</label>
          <select id="ps" className="field" value={current.id} onChange={(e) => setSessionId(Number(e.target.value))}>
            {sessionList.map((s) => <option key={s.id} value={s.id}>{dateRange(s.date, s.endDate)} · {sessionLabel(s)}{s.date === t ? " (today)" : ""}</option>)}
          </select>
        </div>
      ) : (
        <p className="mb-3 text-sm text-slate">No sessions to take attendance for.</p>
      )}
      {current ? (
        <Roll session={current} players={players} groupLabel={groupLabel} onEmergency={setEmergency} onReport={() => setReporting(true)} />
      ) : (
        <PlainList players={players} onEmergency={setEmergency} />
      )}
      {onAddPlayer && <button className="btn-ghost mt-4 w-full" onClick={onAddPlayer}><UserPlus className="h-4 w-4" /> Register a player</button>}
      {emergency && <EmergencyModal player={emergency} schoolName={i.name} onClose={() => setEmergency(null)} />}
      {reporting && current && <ReportModal session={current} players={players} groupLabel={groupLabel} ageGroup={groups.length === 1 ? groups[0] : groups.join("/")} onClose={() => setReporting(false)} />}
    </>
  );
}

function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={`rounded-full px-3 py-1.5 text-sm font-bold ring-1 ${on ? "bg-navy text-white ring-navy" : "bg-white text-slate ring-line"}`}>
      {children}
    </button>
  );
}

/** Attendance for one session, with what's still waiting in the phone's queue applied. */
function useSessionAttendance(sessionId: number) {
  const roll = useQuery({ queryKey: ["attendance", sessionId], queryFn: () => cached<{ canTake: boolean; entries: { playerId: number; status: Status | null }[] }>(`/sessions/${sessionId}/attendance`) });
  const { pending } = useOffline();
  const pendingMap = useMemo(() => {
    const m = new Map<number, Status>();
    for (const op of pending) if (op.type === "attendance" && op.payload.sessionId === sessionId) for (const e of op.payload.entries) m.set(e.playerId, e.status);
    return m;
  }, [pending, sessionId]);
  const server = new Map((roll.data?.entries ?? []).map((e) => [e.playerId, e.status]));
  return {
    loading: roll.isLoading,
    canTake: roll.data?.canTake ?? false,
    statusOf: (id: number) => pendingMap.get(id) ?? server.get(id) ?? null,
    isPending: (id: number) => pendingMap.has(id),
  };
}

function Roll({ session, players, groupLabel, onEmergency, onReport }: {
  session: Session; players: Player[]; groupLabel: string; onEmergency: (p: Player) => void; onReport: () => void;
}) {
  const a = useSessionAttendance(session.id);
  if (a.loading) return <Spinner />;
  const present = players.filter((p) => ["present", "late"].includes(a.statusOf(p.id) ?? "")).length;
  const mark = (p: Player, status: Status) => {
    if (!a.canTake) return;
    void enqueue("attendance", { sessionId: session.id, entries: [{ playerId: p.id, status, recordedAt: new Date().toISOString() }] }, `${p.firstName} ${p.lastName}: ${status}`);
  };
  return (
    <>
      <div className="sticky top-14 z-10 -mx-4 mb-3 flex items-center justify-between gap-3 bg-page/95 px-4 py-2 backdrop-blur md:top-0">
        <div>
          <p className="display text-[2.4rem] text-navy" aria-live="polite">{present}<span className="text-slate"> / {players.length}</span></p>
          <p className="text-sm font-semibold text-slate">present · {groupLabel}</p>
        </div>
        <button className="btn-primary" onClick={onReport}><Send className="h-4 w-4" /> Post-session feedback</button>
      </div>
      {!a.canTake && <p className="mb-3 rounded-xl bg-white p-3 text-sm text-slate ring-1 ring-line">You can see attendance here. Ask an admin for the attendance privilege to mark players.</p>}
      {players.length === 0 ? <Empty>No players in {groupLabel} yet.</Empty> : (
        <ul className="grid gap-2">
          {players.map((p) => {
            const st = a.statusOf(p.id);
            return (
              <li key={p.id} className="sheet flex items-center gap-3 p-3">
                <button
                  onClick={() => mark(p, st === "present" ? "absent" : "present")}
                  disabled={!a.canTake}
                  aria-label={`${p.firstName} ${p.lastName}: ${st ?? "not marked"}. Tap to mark ${st === "present" ? "absent" : "present"}.`}
                  className={`grid h-12 w-12 shrink-0 place-items-center rounded-full text-lg font-bold ring-2 ${st === "present" ? "bg-good text-white ring-good" : st === "late" ? "bg-warn text-white ring-warn" : st === "absent" ? "bg-white text-bad ring-bad/40" : "bg-white text-slate ring-line"}`}
                >
                  {st === "present" ? "✓" : st === "late" ? "L" : st === "absent" ? "✕" : p.firstName[0]}
                </button>
                <Link to={`/players/${p.id}`} className="min-w-0 flex-1">
                  <p className="truncate text-[16px] font-bold text-navy">{p.firstName} {p.lastName}</p>
                  <p className="text-sm text-slate">{p.category || "No age group"}{p.medicalNotes ? " · medical note" : ""}</p>
                </Link>
                {a.isPending(p.id) && <PendingBadge />}
                <button onClick={() => onEmergency(p)} className="btn min-h-10 shrink-0 bg-bad px-3 text-white" aria-label={`Emergency and injury info for ${p.firstName}`}>
                  <ShieldAlert className="h-4 w-4" /><span className="hidden sm:inline">Emergency</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function PlainList({ players, onEmergency }: { players: Player[]; onEmergency: (p: Player) => void }) {
  return (
    <ul className="grid gap-2">
      {players.map((p) => (
        <li key={p.id} className="sheet flex items-center gap-3 p-3">
          <Link to={`/players/${p.id}`} className="min-w-0 flex-1"><p className="font-bold text-navy">{p.firstName} {p.lastName}</p><p className="text-sm text-slate">{p.category}</p></Link>
          <button onClick={() => onEmergency(p)} className="btn min-h-10 bg-bad px-3 text-white" aria-label={`Emergency info for ${p.firstName}`}><ShieldAlert className="h-4 w-4" /></button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Emergency / Injury info. Shows instantly from the roster saved on the phone
 * (works with no signal), then adds linked parent accounts when online.
 */
function EmergencyModal({ player, schoolName, onClose }: { player: Player; schoolName: string; onClose: () => void }) {
  const more = useQuery({ queryKey: ["emergency", player.id], queryFn: () => cached<any>(`/players/${player.id}/emergency`), retry: false });
  const contacts: { name: string; phone: string }[] = more.data?.contacts ?? (player.guardianPhone ? [{ name: player.guardianName || "Parent", phone: player.guardianPhone }] : []);
  const medical = more.data?.medicalNotes ?? player.medicalNotes;
  return (
    <Modal open onClose={onClose} title={`${player.firstName} ${player.lastName}`}>
      <p className="-mt-2 mb-4 text-sm text-slate">{player.category} · {schoolName}</p>
      <div className={`rounded-2xl p-4 ${medical ? "bg-bad/10 ring-1 ring-bad/30" : "bg-page"}`}>
        <p className="text-sm font-bold text-bad">Medical & allergies</p>
        <p className="mt-1 whitespace-pre-line text-[16px]">{medical || "Nothing recorded."}</p>
      </div>
      <p className="label mt-4">Call or text a parent</p>
      {contacts.length === 0 ? (
        <p className="text-[15px] text-slate">No parent number on file. Call the coordinator.</p>
      ) : (
        <ul className="grid gap-2">
          {contacts.map((c) => (
            <li key={c.phone} className="rounded-2xl p-3 ring-1 ring-line">
              <p className="font-bold text-navy">{c.name}</p>
              <p className="text-sm text-slate">{c.phone}</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <a href={`tel:${c.phone}`} className="btn min-h-12 bg-good text-base text-white"><Phone className="h-5 w-5" /> Call</a>
                <a href={`sms:${c.phone}?body=${encodeURIComponent(`Hello, this is ${player.firstName}'s coach at ${schoolName}. `)}`} className="btn-ghost min-h-12 text-base"><MessageSquare className="h-5 w-5" /> SMS</a>
              </div>
            </li>
          ))}
        </ul>
      )}
      {(more.data?.recentInjuries ?? []).length > 0 && (
        <>
          <p className="label mt-4">Recent injuries</p>
          <ul className="grid gap-1 text-sm">
            {more.data.recentInjuries.map((j: any, k: number) => <li key={k}><span className="font-semibold">{j.severity}</span> · {j.bodyPart} {j.description} <span className="text-slate">({dateTime12(j.createdAt)})</span></li>)}
          </ul>
        </>
      )}
      <Link to={`/players/${player.id}`} className="btn-ghost mt-4 w-full">Open player page (report an injury)</Link>
    </Modal>
  );
}

/** Post-session feedback to the admins. Queued like everything else, so it works offline. */
function ReportModal({ session, players, groupLabel, ageGroup, onClose }: {
  session: Session; players: Player[]; groupLabel: string; ageGroup: string; onClose: () => void;
}) {
  const a = useSessionAttendance(session.id);
  const qc = useQueryClient();
  const present = players.filter((p) => ["present", "late"].includes(a.statusOf(p.id) ?? ""));
  const absent = players.filter((p) => a.statusOf(p.id) === "absent").map((p) => p.firstName);
  const [f, setF] = useState({
    attendanceSummary: `${present.length} of ${players.length} present (${groupLabel}).${absent.length ? ` Absent: ${absent.join(", ")}.` : ""}`,
    playerProgress: "",
    pitchNotes: "",
  });
  const [sent, setSent] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await enqueue("session_report", { sessionId: session.id, ageGroup, presentCount: present.length, rosterCount: players.length, ...f }, `Session report ${dateRange(session.date, session.endDate)}`);
    void qc.invalidateQueries({ queryKey: ["reports"] });
    setSent(true);
  };
  return (
    <Modal open onClose={onClose} title="Post-session feedback">
      {sent ? (
        <div className="grid gap-3">
          <Notice tone="good">Sent to the admins. If you're offline, it goes as soon as you have signal.</Notice>
          <button className="btn-primary" onClick={onClose}>Done</button>
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-3">
          <p className="text-sm text-slate">{sessionLabel(session)}, {dateRange(session.date, session.endDate)} · {groupLabel}</p>
          <div><label className="label" htmlFor="ra">Attendance summary</label><textarea id="ra" className="field" rows={2} value={f.attendanceSummary} onChange={(e) => setF({ ...f, attendanceSummary: e.target.value })} /></div>
          <div><label className="label" htmlFor="rp">Player progress</label><textarea id="rp" className="field" rows={3} placeholder="Who stood out, who needs support" value={f.playerProgress} onChange={(e) => setF({ ...f, playerProgress: e.target.value })} /></div>
          <div><label className="label" htmlFor="rn">Pitch notes</label><textarea id="rn" className="field" rows={2} placeholder="Pitch condition, equipment, safety" value={f.pitchNotes} onChange={(e) => setF({ ...f, pitchNotes: e.target.value })} /></div>
          <button className="btn-primary"><Send className="h-4 w-4" /> Send to admins</button>
        </form>
      )}
    </Modal>
  );
}

/** Admins: every post-session report for this school. */
export function ReportsTab({ i }: { i: Intramural }) {
  const q = useQuery({ queryKey: ["reports", i.id], queryFn: () => cached<any[]>(`/intramurals/${i.id}/reports`) });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  return q.data!.length === 0 ? <Empty>Coaches' post-session reports will appear here.</Empty> : (
    <ul className="grid gap-3">
      {q.data!.map((r) => (
        <li key={r.id} className="sheet text-[15px]">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-bold text-navy">{dateRange(r.sessionDate)}{r.ageGroup ? ` · ${r.ageGroup}` : ""}</p>
            <p className="display text-2xl text-navy">{r.presentCount}<span className="text-slate">/{r.rosterCount}</span></p>
          </div>
          <p className="text-sm text-slate">{r.coach ?? "A coach"} · {dateTime12(r.createdAt)}</p>
          {r.attendanceSummary && <p className="mt-2">{r.attendanceSummary}</p>}
          {r.playerProgress && <><SectionTitle>Player progress</SectionTitle><p className="-mt-1 whitespace-pre-line">{r.playerProgress}</p></>}
          {r.pitchNotes && <p className="mt-2"><span className="font-semibold">Pitch:</span> {r.pitchNotes}</p>}
        </li>
      ))}
    </ul>
  );
}
