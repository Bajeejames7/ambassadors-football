import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, UserMinus, UserPlus, X } from "lucide-react";
import { api } from "../lib/api";
import { type Intramural } from "../lib/queries";
import { AGE_GROUPS, dateTime12, money, PERMISSION_LABELS, time12, WEEKDAYS } from "../lib/format";
import { Empty, ErrorNote, Modal, Notice, SectionTitle, Spinner } from "../components/ui";
import { ScheduleEditor } from "./Staff";

const GRANTABLE = ["attendance.take", "players.register", "equipment.check", "reports.generate"];

// ---- Setup -----------------------------------------------------------------------------------

export function SetupTab({ i }: { i: Intramural }) {
  const qc = useQueryClient();
  const canEdit = i.myPermissions.includes("schedules.edit");
  const [f, setF] = useState({
    name: i.name, shortCode: i.shortCode, color: i.color, coordinatorName: i.coordinatorName, sessionWeekday: i.sessionWeekday,
    sessionStart: i.sessionStart, sessionEnd: i.sessionEnd, location: i.location, dressCode: i.dressCode, programMode: i.programMode,
  });
  const [schedule, setSchedule] = useState(i.defaultSchedule);
  const [roles, setRoles] = useState(i.defaultRoles.join("\n"));
  const [categories, setCategories] = useState(i.categories.join("\n"));
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(`/intramurals/${i.id}`, {
        method: "PATCH",
        body: { ...f, defaultSchedule: schedule.filter((r) => r.activity.trim()), defaultRoles: lines(roles), categories: lines(categories) },
      });
      setMsg({ tone: "good", text: `Saved. Upcoming sessions now show as "${WEEKDAYS[f.sessionWeekday]} Session".` });
      void qc.invalidateQueries();
    } catch (err) {
      setMsg({ tone: "bad", text: (err as Error).message });
    }
  };
  return (
    <>
      {canEdit && (
        <form onSubmit={save} className="sheet grid gap-3">
          <h2 className="condensed text-lg text-navy">Program type</h2>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Program type">
            {([
              ["school", "School", "4 Virtue Teams: team rosters, virtue points and team assignments."],
              ["club", "Club", "Special events & camps (Summer Camp, clinics, tournaments) alongside sessions."],
            ] as const).map(([mode, title, text]) => (
              <button type="button" role="radio" aria-checked={f.programMode === mode} key={mode} onClick={() => setF({ ...f, programMode: mode })}
                className={`rounded-xl p-3 text-left ring-1 ${f.programMode === mode ? "bg-navy text-white ring-navy" : "ring-line"}`}>
                <span className="block font-bold">{title}</span>
                <span className={`block text-sm ${f.programMode === mode ? "text-white/80" : "text-slate"}`}>{text}</span>
              </button>
            ))}
          </div>
          <h2 className="condensed mt-2 text-lg text-navy">Regular session</h2>
          <div>
            <span className="label">Session day</span>
            <div className="grid grid-cols-7 gap-1" role="radiogroup" aria-label="Session day">
              {WEEKDAYS.map((d, n) => (
                <button type="button" role="radio" aria-checked={f.sessionWeekday === n} key={d} onClick={() => setF({ ...f, sessionWeekday: n })}
                  className={`rounded-lg py-2 text-xs font-bold ring-1 ${f.sessionWeekday === n ? "bg-navy text-white ring-navy" : "ring-line"}`}>{d.slice(0, 3)}</button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="ss">Players arrive</label><input id="ss" type="time" className="field" value={f.sessionStart} onChange={(e) => setF({ ...f, sessionStart: e.target.value })} /><p className="mt-1 text-xs text-slate">{time12(f.sessionStart)}</p></div>
            <div><label className="label" htmlFor="se">Players leave</label><input id="se" type="time" className="field" value={f.sessionEnd} onChange={(e) => setF({ ...f, sessionEnd: e.target.value })} /><p className="mt-1 text-xs text-slate">{time12(f.sessionEnd)}</p></div>
          </div>
          <div><label className="label" htmlFor="sl">Pitch / location</label><input id="sl" className="field" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></div>
          <div><label className="label" htmlFor="sd">Kit / dress code</label><input id="sd" className="field" value={f.dressCode} onChange={(e) => setF({ ...f, dressCode: e.target.value })} /></div>
          <ScheduleEditor value={schedule} onChange={setSchedule} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div><label className="label" htmlFor="sr">Coach roles (one per line)</label><textarea id="sr" className="field" rows={5} value={roles} onChange={(e) => setRoles(e.target.value)} /></div>
            <div><label className="label" htmlFor="sc">Age groups (one per line)</label><textarea id="sc" className="field" rows={5} value={categories} onChange={(e) => setCategories(e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="sco">Coordinator</label><input id="sco" className="field" value={f.coordinatorName} onChange={(e) => setF({ ...f, coordinatorName: e.target.value })} /></div>
            <div><label className="label" htmlFor="scl">Colour</label><input id="scl" type="color" className="field h-11 p-1" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} /></div>
          </div>
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          <button className="btn-primary justify-self-start">Save setup</button>
        </form>
      )}
      {i.myPermissions.includes("airtable.manage") && <AirtableSetup i={i} />}
      {i.myPermissions.includes("roles.assign") && <Coaches i={i} />}
      {canEdit && <EquipmentSetup i={i} />}
    </>
  );
}

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

function AirtableSetup({ i }: { i: Intramural }) {
  const qc = useQueryClient();
  const a = i.airtable ?? {};
  const [f, setF] = useState({ formUrl: a.formUrl ?? "", baseId: a.baseId ?? "", tableName: a.tableName ?? "", viewName: a.viewName ?? "", pushWalkIns: !!a.pushWalkIns, fieldMap: a.fieldMap ?? {} });
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const fromLink = (url: string) => {
    const m = url.match(/airtable\.com\/(app[A-Za-z0-9]{14})/);
    setF({ ...f, formUrl: url, baseId: m && !f.baseId ? m[1] : f.baseId });
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(`/intramurals/${i.id}/airtable`, { method: "PUT", body: { ...f, ...(token ? { apiToken: token } : {}) } });
      setToken("");
      setMsg({ tone: "good", text: "Airtable link saved." });
      void qc.invalidateQueries({ queryKey: ["intramural", i.id] });
    } catch (err) {
      setMsg({ tone: "bad", text: (err as Error).message });
    }
  };
  const FIELDS: [string, string][] = [["name", "Player full name"], ["firstName", "First name (if separate)"], ["lastName", "Last name (if separate)"], ["category", "Age group"], ["guardianName", "Parent name"], ["guardianEmail", "Parent email"], ["guardianPhone", "Parent phone"], ["dateOfBirth", "Date of birth"]];
  return (
    <form onSubmit={save} className="sheet mt-4 grid gap-3">
      <h2 className="condensed text-lg text-navy">Airtable for {i.name}</h2>
      <div>
        <label className="label" htmlFor="af">Airtable registration & M-PESA form URL</label>
        <input id="af" className="field" placeholder="https://airtable.com/app…/shr…" value={f.formUrl} onChange={(e) => fromLink(e.target.value)} />
        <p className="mt-1 text-xs text-slate">Parents see this form inside the app (Register & pay) to register and pay by M-PESA.{f.formUrl && <> <a className="font-semibold text-brand" href={f.formUrl} target="_blank" rel="noreferrer">Test it <ExternalLink className="inline h-3 w-3" /></a></>}</p>
      </div>
      <p className="text-sm font-semibold text-navy">Instant player search (optional)</p>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label" htmlFor="ab">Base ID</label><input id="ab" className="field" placeholder="appXXXXXXXXXXXXXX" value={f.baseId} onChange={(e) => setF({ ...f, baseId: e.target.value.trim() })} /></div>
        <div><label className="label" htmlFor="at">Table name</label><input id="at" className="field" placeholder="e.g. Registrations" value={f.tableName} onChange={(e) => setF({ ...f, tableName: e.target.value })} /></div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label" htmlFor="av">View (optional)</label><input id="av" className="field" value={f.viewName} onChange={(e) => setF({ ...f, viewName: e.target.value })} /></div>
        <div>
          <label className="label" htmlFor="ak">Access token</label>
          <input id="ak" className="field" type="password" autoComplete="off" placeholder={a.hasToken ? "Saved. Type to replace" : "pat…"} value={token} onChange={(e) => setToken(e.target.value)} />
        </div>
      </div>
      <p className="text-xs text-slate">Create a personal access token in Airtable with the data.records:read scope (and data.records:write to send walk-ins), limited to this base. It is stored on the server and never sent to phones.</p>
      <details>
        <summary className="cursor-pointer text-sm font-semibold text-brand">Match your Airtable field names</summary>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {FIELDS.map(([k, label]) => (
            <div key={k}><label className="label text-xs" htmlFor={`fm-${k}`}>{label}</label><input id={`fm-${k}`} className="field py-1.5 text-sm" value={f.fieldMap[k] ?? ""} onChange={(e) => setF({ ...f, fieldMap: { ...f.fieldMap, [k]: e.target.value } })} /></div>
          ))}
        </div>
      </details>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.pushWalkIns} onChange={(e) => setF({ ...f, pushWalkIns: e.target.checked })} /> Also add walk-in players to this Airtable table</label>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <button className="btn-primary justify-self-start">Save Airtable link</button>
    </form>
  );
}

function EquipmentSetup({ i }: { i: Intramural }) {
  const qc = useQueryClient();
  const [items, setItems] = useState(i.equipment ?? []);
  const [msg, setMsg] = useState("");
  const save = async () => {
    const saved = await api(`/intramurals/${i.id}/equipment`, { method: "PUT", body: { items: items.filter((x) => x.name.trim()) } });
    setItems(saved);
    setMsg("Equipment list saved.");
    void qc.invalidateQueries({ queryKey: ["intramural", i.id] });
  };
  return (
    <div className="sheet mt-4">
      <h2 className="condensed text-lg text-navy">Equipment checklist</h2>
      <p className="mt-1 text-sm text-slate">Counted before and after every session.</p>
      <ul className="mt-3 grid gap-2">
        {items.map((it, k) => (
          <li key={it.id ?? `new-${k}`} className="flex items-center gap-2">
            <input className="field" aria-label="Item" value={it.name} onChange={(e) => setItems(items.map((x, n) => (n === k ? { ...x, name: e.target.value } : x)))} />
            <input className="field w-20" aria-label="How many" type="number" min={0} value={it.expected} onChange={(e) => setItems(items.map((x, n) => (n === k ? { ...x, expected: Number(e.target.value) } : x)))} />
            <label className="flex items-center gap-1 text-xs text-slate"><input type="checkbox" checked={it.active} onChange={(e) => setItems(items.map((x, n) => (n === k ? { ...x, active: e.target.checked } : x)))} /> Used</label>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <button className="btn-ghost" onClick={() => setItems([...items, { id: undefined as unknown as number, name: "", expected: 1, active: true }])}>Add item</button>
        <button className="btn-primary" onClick={save}>Save list</button>
      </div>
      {msg && <Notice tone="good">{msg}</Notice>}
    </div>
  );
}

// ---- People ----------------------------------------------------------------------------------

/** Which age groups a coach takes at this school (none ticked = all ages). Saves on tap. */
function AgeGroupChips({ i, user, onSaved }: { i: Intramural; user: any; onSaved: () => void }) {
  const [groups, setGroups] = useState<string[]>(user.ageGroups ?? []);
  const toggle = async (g: string) => {
    const next = groups.includes(g) ? groups.filter((x) => x !== g) : [...groups, g];
    setGroups(next);
    await api(`/intramurals/${i.id}/coaches/${user.id}/age-groups`, { method: "PUT", body: { ageGroups: next } }).catch(() => setGroups(groups));
    onSaved();
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1" role="group" aria-label={`Age groups for ${user.name}`}>
      {AGE_GROUPS.map((g) => (
        <button type="button" key={g} aria-pressed={groups.includes(g)} onClick={() => toggle(g)}
          className={`rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${groups.includes(g) ? "bg-navy text-white ring-navy" : "text-slate ring-line"}`}>{g}</button>
      ))}
      <span className="pl-1 text-xs text-slate">{groups.length ? "" : "All ages"}</span>
    </div>
  );
}

export function PeopleTab({ i }: { i: Intramural }) {
  const p = i.myPermissions;
  return (
    <>
      {p.includes("parents.approve") && <ParentApprovals i={i} />}
      <Coaches i={i} />
    </>
  );
}

export function Coaches({ i }: { i: Intramural }) {
  const qc = useQueryClient();
  const p = i.myPermissions;
  const staff = useQuery({ queryKey: ["people", i.id], queryFn: () => api<any[]>(`/intramurals/${i.id}/people`) });
  const available = useQuery({ queryKey: ["available", i.id], queryFn: () => api<any[]>(`/intramurals/${i.id}/available-coaches`), enabled: p.includes("roles.assign") });
  const [editing, setEditing] = useState<any | null>(null);
  const [addId, setAddId] = useState("");
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["people", i.id] }); void qc.invalidateQueries({ queryKey: ["available", i.id] }); };
  const add = async () => {
    try { await api(`/intramurals/${i.id}/coaches`, { method: "POST", body: { userId: Number(addId) } }); setAddId(""); refresh(); }
    catch (err) { setMsg({ tone: "bad", text: (err as Error).message }); }
  };
  const remove = async (u: any) => {
    if (!confirm(`Remove ${u.name} from ${i.name}?`)) return;
    try { await api(`/intramurals/${i.id}/coaches/${u.id}`, { method: "DELETE" }); refresh(); }
    catch (err) { setMsg({ tone: "bad", text: (err as Error).message }); }
  };
  if (staff.isLoading) return <Spinner />;
  if (staff.error) return <ErrorNote error={staff.error} />;
  return (
    <>
      <SectionTitle>Coaches and admins</SectionTitle>
      {p.includes("roles.assign") && (available.data ?? []).length > 0 && (
        <div className="mb-3 flex gap-2">
          <select className="field" value={addId} onChange={(e) => setAddId(e.target.value)} aria-label="Coach to add">
            <option value="">Add a coach from {i.countryName}…</option>
            {available.data!.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.email})</option>)}
          </select>
          <button className="btn-primary" disabled={!addId} onClick={add}><UserPlus className="h-4 w-4" /> Add</button>
        </div>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <ul className="sheet divide-y divide-line py-1">
        {staff.data!.map((u) => {
          const field = u.grants.filter((g: any) => g.intramuralId === i.id && GRANTABLE.includes(g.permission));
          return (
            <li key={u.id} className="py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-navy">{u.name} <span className="text-sm font-normal text-slate">{u.role === "coach" ? "Coach" : u.role === "admin" ? "Admin" : "Super Admin"}</span></p>
                  {u.email && <p className="truncate text-sm text-slate">{u.email}{u.phone ? ` · ${u.phone}` : ""}</p>}
                </div>
                {u.role === "coach" && p.includes("privileges.grant") && <button className="btn-ghost min-h-9" onClick={() => setEditing(u)}>Privileges</button>}
                {u.role === "coach" && p.includes("roles.assign") && <button className="p-2 text-slate hover:text-bad" aria-label={`Remove ${u.name}`} onClick={() => remove(u)}><UserMinus className="h-4 w-4" /></button>}
              </div>
              {u.role === "coach" && p.includes("roles.assign") && <AgeGroupChips i={i} user={u} onSaved={refresh} />}
              {field.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {field.map((g: any) => <span key={g.permission} className="chip bg-brand/10 text-brand">{PERMISSION_LABELS[g.permission]}{g.expiresAt ? ` until ${new Date(g.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}</span>)}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {editing && <PrivilegeEditor i={i} user={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
    </>
  );
}

/** Task-specific field privileges for one coach (never Setup or delete controls). */
function PrivilegeEditor({ i, user, onClose, onSaved }: { i: Intramural; user: any; onClose: () => void; onSaved: () => void }) {
  const current = new Map<string, string | null>(user.grants.filter((g: any) => g.intramuralId === i.id).map((g: any) => [g.permission, g.expiresAt]));
  const [chosen, setChosen] = useState<Record<string, { on: boolean; until: string }>>(
    Object.fromEntries(GRANTABLE.map((p) => [p, { on: current.has(p), until: current.get(p)?.slice(0, 10) ?? "" }])),
  );
  const [error, setError] = useState("");
  const save = async () => {
    try {
      await api(`/intramurals/${i.id}/coaches/${user.id}/privileges`, {
        method: "PUT",
        body: { privileges: Object.entries(chosen).filter(([, v]) => v.on).map(([permission, v]) => ({ permission, expiresAt: v.until ? new Date(`${v.until}T23:59:59+03:00`).toISOString() : null })) },
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal open onClose={onClose} title={`${user.name}'s field privileges`}>
      <p className="mb-3 text-sm text-slate">For {i.name} only. Leave the date empty to keep it until you remove it.</p>
      <ul className="grid gap-2">
        {GRANTABLE.filter((p) => i.myPermissions.includes(p)).map((p) => (
          <li key={p} className="rounded-xl p-3 ring-1 ring-line">
            <label className="flex items-center gap-2 font-semibold"><input type="checkbox" className="h-4 w-4" checked={chosen[p].on} onChange={(e) => setChosen({ ...chosen, [p]: { ...chosen[p], on: e.target.checked } })} />{PERMISSION_LABELS[p]}</label>
            {chosen[p].on && (
              <label className="mt-2 flex items-center gap-2 pl-6 text-sm text-slate">Until <input type="date" className="field w-auto py-1" value={chosen[p].until} onChange={(e) => setChosen({ ...chosen, [p]: { ...chosen[p], until: e.target.value } })} /></label>
            )}
          </li>
        ))}
      </ul>
      {error && <Notice tone="bad">{error}</Notice>}
      <button className="btn-primary mt-4 w-full" onClick={save}>Save privileges</button>
    </Modal>
  );
}

function ParentApprovals({ i }: { i: Intramural }) {
  const qc = useQueryClient();
  const requests = useQuery({ queryKey: ["parent-requests", i.id], queryFn: () => api<any[]>(`/intramurals/${i.id}/parent-requests`) });
  const unlinked = useQuery({ queryKey: ["unlinked", i.id], queryFn: () => api<any[]>(`/intramurals/${i.id}/unlinked-parents`) });
  const players = useQuery({ queryKey: ["players", i.id], queryFn: () => api<any[]>(`/intramurals/${i.id}/players`) });
  const [linkFor, setLinkFor] = useState<any | null>(null);
  const [pick, setPick] = useState<number[]>([]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["parent-requests", i.id] }); void qc.invalidateQueries({ queryKey: ["unlinked", i.id] }); };
  const approve = async (parentId: number, playerIds: number[]) => {
    await api("/parent-links/approve", { method: "POST", body: { parentId, playerIds } });
    refresh();
  };
  const reject = async (parentId: number, playerId: number) => {
    await api("/parent-links/remove", { method: "POST", body: { parentId, playerId } });
    refresh();
  };
  const list = requests.data ?? [];
  const loose = unlinked.data ?? [];
  return (
    <>
      <SectionTitle>Parents waiting for approval</SectionTitle>
      {list.length === 0 && loose.length === 0 ? <Empty>No parents waiting.</Empty> : (
        <ul className="grid gap-2">
          {list.map((r) => (
            <li key={r.id} className="sheet">
              <p className="font-bold text-navy">{r.name}</p>
              <p className="text-sm text-slate">{r.email} · {r.phone}</p>
              <ul className="mt-2 grid gap-1">
                {r.children.filter((c: any) => !c.verified).map((c: any) => (
                  <li key={c.playerId} className="flex items-center justify-between gap-2 rounded-xl bg-page px-3 py-2">
                    <span className="text-[15px]"><span className="font-semibold">{c.name}</span><span className="block text-xs text-slate">Registered with {[c.guardianEmail, c.guardianPhone].filter(Boolean).join(" / ") || "no contact"}</span></span>
                    <span className="flex gap-1">
                      <button className="btn min-h-9 bg-good px-3 text-white" onClick={() => approve(r.id, [c.playerId])}><Check className="h-4 w-4" /> Confirm</button>
                      <button className="btn-ghost min-h-9 px-3" aria-label="Not their child" onClick={() => reject(r.id, c.playerId)}><X className="h-4 w-4" /></button>
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
          {loose.map((r) => (
            <li key={r.id} className="sheet flex items-center gap-3">
              <div className="flex-1"><p className="font-bold text-navy">{r.name}</p><p className="text-sm text-slate">{r.email} · {r.phone} · no matching child found</p></div>
              <button className="btn-ghost min-h-9" onClick={() => { setLinkFor(r); setPick([]); }}>Link a child</button>
            </li>
          ))}
        </ul>
      )}
      {linkFor && (
        <Modal open onClose={() => setLinkFor(null)} title={`Link ${linkFor.name}`}>
          <p className="mb-2 text-sm text-slate">Only link children after checking with the parent.</p>
          <ul className="max-h-80 overflow-y-auto">
            {(players.data ?? []).map((p) => (
              <li key={p.id}><label className="flex items-center gap-2 py-1.5"><input type="checkbox" checked={pick.includes(p.id)} onChange={(e) => setPick(e.target.checked ? [...pick, p.id] : pick.filter((x) => x !== p.id))} />{p.firstName} {p.lastName} <span className="text-xs text-slate">{p.guardianName}</span></label></li>
            ))}
          </ul>
          <button className="btn-primary mt-3 w-full" disabled={!pick.length} onClick={async () => { await approve(linkFor.id, pick); setLinkFor(null); }}>Link and approve</button>
        </Modal>
      )}
    </>
  );
}

// ---- Payments --------------------------------------------------------------------------------

const PAY_FILTERS = [
  { id: "all", label: "All" },
  { id: "completed", label: "Completed" },
  { id: "pending", label: "Pending" },
  { id: "unpaid", label: "Unpaid" },
] as const;

const STATUS_CHIP: Record<string, string> = {
  completed: "bg-good/15 text-good", paid: "bg-good/15 text-good",
  pending: "bg-brand/10 text-brand", partial: "bg-warn/15 text-warn",
  unpaid: "bg-bad/10 text-bad", failed: "bg-bad/10 text-bad", cancelled: "bg-page text-slate", no_charge: "bg-page text-slate",
};

/**
 * Payments for this school or club: totals, paid vs unpaid children, and every
 * M-PESA record (receipt, phone, time). Refreshes every 10 seconds while open.
 */
export function PaymentsTab({ i }: { i: Intramural }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<(typeof PAY_FILTERS)[number]["id"]>("all");
  const q = useQuery({
    queryKey: ["payments", i.id, filter],
    queryFn: () => api<any>(`/intramurals/${i.id}/payments?status=${filter}`),
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
  const [bulk, setBulk] = useState(false);
  const [player, setPlayer] = useState<any | null>(null);
  const [unpaid, setUnpaid] = useState(false);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { balances, records, totals, config } = q.data;
  const refresh = () => void qc.invalidateQueries({ queryKey: ["payments", i.id] });
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="sheet !p-4"><p className="text-xs font-semibold text-slate">Collected</p><p className="display mt-1 text-[1.7rem] text-good">{money(totals.collected, i.currency)}</p></div>
        <div className="sheet !p-4"><p className="text-xs font-semibold text-slate">Outstanding</p><p className="display mt-1 text-[1.7rem] text-navy">{money(totals.outstanding, i.currency)}</p></div>
        <div className="sheet !p-4"><p className="text-xs font-semibold text-slate">Paid players</p><p className="display mt-1 text-[1.7rem] text-navy">{totals.paidPlayers}</p></div>
        <div className="sheet !p-4"><p className="text-xs font-semibold text-slate">Unpaid players</p><p className="display mt-1 text-[1.7rem] text-bad">{totals.unpaidPlayers}</p></div>
      </div>
      <p className="mt-2 text-sm text-slate">
        {config?.termLabel ? `${config.termLabel}: ${config.feeAmount ? money(Number(config.feeAmount), i.currency) : "no fee set"} per child, set by the Super Admin.` : "No term fee set yet. The Super Admin sets it in Creator Control, Payments."}
        {" "}Updates every 10 seconds.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn-primary" onClick={() => setUnpaid(true)}>Send unpaid alert</button>
        <button className="btn-ghost" onClick={() => setBulk(true)}>Charge everyone (tournament, kit…)</button>
      </div>
      <UnpaidList i={i} />

      <div role="tablist" aria-label="Filter payments" className="mt-6 mb-3 flex flex-wrap gap-2">
        {PAY_FILTERS.map((f) => (
          <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}
            className={`rounded-full px-3.5 py-2 text-sm font-semibold ${filter === f.id ? "bg-navy text-white" : "bg-white text-slate ring-1 ring-line"}`}>
            {f.label}{f.id === "pending" && totals.pending ? ` (${totals.pending})` : ""}
          </button>
        ))}
      </div>

      {filter === "unpaid" ? (
        <ul className="sheet divide-y divide-line py-1">
          {balances.map((b: any) => (
            <li key={b.playerId}>
              <button className="flex w-full items-center justify-between gap-3 py-2.5 text-left" onClick={() => setPlayer(b)}>
                <span className="min-w-0">
                  <span className="font-semibold">{b.name}</span> <span className="text-sm text-slate">{b.category}</span>
                  <span className="block truncate text-xs text-slate">{b.parentPhones ? `Parent: ${b.parentPhones}` : "No parent phone on file"}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-bold text-navy">{money(b.balance, i.currency)}</span>
                  <span className={`chip ${STATUS_CHIP[b.status]}`}>{b.status === "partial" ? "part paid" : b.status}</span>
                </span>
              </button>
            </li>
          ))}
          {balances.length === 0 && <li className="py-3 text-slate">Everyone has paid.</li>}
        </ul>
      ) : (
        <div className="sheet overflow-x-auto !p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-line text-left text-xs text-slate">
              <tr>
                <th className="px-4 py-2.5">Player</th><th className="px-2">Amount</th><th className="px-2">Status</th>
                <th className="px-2">M-PESA receipt</th><th className="px-2">Parent phone</th><th className="px-4">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {records.map((r: any) => (
                <tr key={r.id}>
                  <td className="px-4 py-2.5 font-semibold text-ink">{r.playerName}{r.feeTitle && <span className="block text-xs font-normal text-slate">{r.feeTitle}</span>}</td>
                  <td className="px-2 tabular-nums">{money(Number(r.amount), i.currency)}</td>
                  <td className="px-2"><span className={`chip ${STATUS_CHIP[r.status]}`}>{r.status}</span></td>
                  <td className="px-2 font-mono text-xs">{r.receipt ?? (r.method === "mpesa" ? "" : r.method)}</td>
                  <td className="px-2 tabular-nums">{r.phone ? `+${r.phone}` : ""}</td>
                  <td className="px-4 text-xs text-slate">{dateTime12(r.completedAt ?? r.createdAt)}</td>
                </tr>
              ))}
              {records.length === 0 && <tr><td colSpan={6} className="px-4 py-4 text-slate">No payments match this filter.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {filter !== "unpaid" && (
        <>
          <SectionTitle>Every child</SectionTitle>
          <ul className="sheet divide-y divide-line py-1">
            {balances.map((b: any) => (
              <li key={b.playerId}>
                <button className="flex w-full items-center justify-between gap-3 py-2.5 text-left" onClick={() => setPlayer(b)}>
                  <span><span className="font-semibold">{b.name}</span> <span className="text-sm text-slate">{b.category}</span></span>
                  <span className="flex items-center gap-2">
                    <span className={`chip ${STATUS_CHIP[b.status]}`}>{b.status === "no_charge" ? "no fee" : b.status === "partial" ? "part paid" : b.status}</span>
                    <span className={`font-bold ${b.balance > 0 ? "text-navy" : "text-good"}`}>{money(b.balance, i.currency)}</span>
                  </span>
                </button>
              </li>
            ))}
            {balances.length === 0 && <li className="py-3 text-slate">No players yet.</li>}
          </ul>
        </>
      )}
      {unpaid && <UnpaidForm i={i} players={balances} onClose={() => setUnpaid(false)} onSaved={() => { setUnpaid(false); void qc.invalidateQueries({ queryKey: ["unpaid-open", i.id] }); }} />}
      {bulk && <ChargeForm title="Charge every player" path={`/intramurals/${i.id}/fees`} categories={i.categories} onClose={() => setBulk(false)} onSaved={() => { setBulk(false); refresh(); }} />}
      {player && <PlayerCharge i={i} player={player} onClose={() => setPlayer(null)} onSaved={() => { setPlayer(null); refresh(); }} />}
    </>
  );
}

function ChargeForm({ title, path, categories, onClose, onSaved, extra }: { title: string; path: string; categories?: string[]; onClose: () => void; onSaved: () => void; extra?: React.ReactNode }) {
  const [f, setF] = useState({ kind: "subscription", title: "", amount: "", dueDate: "", category: "" });
  const [error, setError] = useState("");
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(path, { method: "POST", body: { kind: f.kind, title: f.title, amount: Number(f.amount), dueDate: f.dueDate || null, ...(f.category ? { category: f.category } : {}) } });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal open onClose={onClose} title={title}>
      <form onSubmit={save} className="grid gap-3">
        <select className="field" aria-label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="subscription">Subscription</option><option value="tournament">Tournament</option><option value="kit">Kit</option><option value="other">Other</option>
        </select>
        <div><label className="label" htmlFor="ct">What for</label><input id="ct" className="field" required placeholder="e.g. Term 1 2027 subscription" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="ca">Amount</label><input id="ca" className="field" required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
          <div><label className="label" htmlFor="cd">Due</label><input id="cd" type="date" className="field" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></div>
        </div>
        {categories && <select className="field" aria-label="Only this age group" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">Every age group</option>{categories.map((c) => <option key={c}>{c}</option>)}</select>}
        {error && <Notice tone="bad">{error}</Notice>}
        <button className="btn-primary">Add charge and tell parents</button>
      </form>
      {extra}
    </Modal>
  );
}

function PlayerCharge({ i, player, onClose, onSaved }: { i: Intramural; player: any; onClose: () => void; onSaved: () => void }) {
  const [mode, setMode] = useState<"charge" | "cash">("charge");
  const [cash, setCash] = useState({ method: "cash", amount: "" });
  const [error, setError] = useState("");
  if (mode === "charge") {
    return (
      <ChargeForm title={`Charge ${player.name}`} path={`/players/${player.playerId}/fees`} onClose={onClose} onSaved={onSaved}
        extra={<button className="btn-ghost mt-3 w-full" onClick={() => setMode("cash")}>Record a cash or bank payment instead</button>} />
    );
  }
  return (
    <Modal open onClose={onClose} title={`Payment from ${player.name}`}>
      <form className="grid gap-3" onSubmit={async (e) => {
        e.preventDefault();
        try { await api(`/players/${player.playerId}/payments/manual`, { method: "POST", body: { method: cash.method, amount: Number(cash.amount) } }); onSaved(); }
        catch (err) { setError((err as Error).message); }
      }}>
        <select className="field" aria-label="Method" value={cash.method} onChange={(e) => setCash({ ...cash, method: e.target.value })}><option value="cash">Cash</option><option value="bank">Bank transfer</option></select>
        <div><label className="label" htmlFor="cm">Amount ({i.currency})</label><input id="cm" className="field" inputMode="decimal" required value={cash.amount} onChange={(e) => setCash({ ...cash, amount: e.target.value })} /></div>
        {error && <Notice tone="bad">{error}</Notice>}
        <button className="btn-primary">Record payment</button>
      </form>
    </Modal>
  );
}

// ---- Unpaid session / camp alerts -------------------------------------------------------------

function UnpaidList({ i }: { i: Intramural }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["unpaid-open", i.id], queryFn: () => api<any[]>(`/intramurals/${i.id}/unpaid-alerts`) });
  const resolve = async (id: number) => {
    await api(`/unpaid-alerts/${id}/resolve`, { method: "POST" });
    void qc.invalidateQueries({ queryKey: ["unpaid-open", i.id] });
  };
  if (!q.data?.length) return null;
  return (
    <>
      <SectionTitle>Unpaid alerts sent</SectionTitle>
      <ul className="sheet divide-y divide-line py-1">
        {q.data.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
            <span className="text-[15px]"><span className="font-semibold">{a.playerName}</span> <span className="text-slate">{a.category}</span><span className="block text-sm">{a.title}{a.amount ? ` · ${money(Number(a.amount), i.currency)}` : ""}</span></span>
            <button className="btn-ghost min-h-9 px-3" onClick={() => resolve(a.id)}>Mark paid</button>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Flag one or more players unpaid for a session or camp; their parents get an urgent alert. */
function UnpaidForm({ i, players, onClose, onSaved }: { i: Intramural; players: any[]; onClose: () => void; onSaved: () => void }) {
  const sessions = useQuery({ queryKey: ["sessions", i.id], queryFn: () => api<any[]>(`/intramurals/${i.id}/sessions`) });
  const [f, setF] = useState({ title: "", amount: "", note: "", sessionId: "" });
  const [group, setGroup] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [error, setError] = useState("");
  const shown = players.filter((p) => !group || p.category === group);
  const events = (sessions.data ?? []).filter((s) => s.kind !== "training" || s.date >= new Date().toISOString().slice(0, 10)).slice(0, 30);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await api("/unpaid-alerts", { method: "POST", body: { playerIds: picked, title: f.title, amount: f.amount ? Number(f.amount) : null, note: f.note, sessionId: f.sessionId ? Number(f.sessionId) : null } });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal open onClose={onClose} title="Send unpaid alert">
      <form onSubmit={submit} className="grid gap-3">
        <div><label className="label" htmlFor="us">For a session or camp (optional)</label>
          <select id="us" className="field" value={f.sessionId} onChange={(e) => {
            const s = events.find((x) => String(x.id) === e.target.value);
            setF({ ...f, sessionId: e.target.value, title: f.title || (s ? (s.title || (s.kind === "training" ? `${s.dayLabel} session ${s.date}` : s.kind)) : "") });
          }}>
            <option value="">General</option>
            {events.map((s) => <option key={s.id} value={s.id}>{s.date} · {s.title || (s.kind === "training" ? `${s.dayLabel} session` : s.kind)}</option>)}
          </select>
        </div>
        <div><label className="label" htmlFor="ut">What is unpaid</label><input id="ut" className="field" required placeholder="e.g. Summer Camp" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="ua">Amount ({i.currency})</label><input id="ua" className="field" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
          <div><label className="label" htmlFor="ug">Age group</label>
            <select id="ug" className="field" value={group} onChange={(e) => setGroup(e.target.value)}><option value="">All</option>{AGE_GROUPS.map((g) => <option key={g}>{g}</option>)}</select>
          </div>
        </div>
        <div><label className="label" htmlFor="un">Message to parents</label><input id="un" className="field" placeholder="e.g. Please pay by Friday" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
        <fieldset>
          <legend className="label">Players ({picked.length} chosen)</legend>
          <button type="button" className="mb-1 text-sm font-semibold text-brand" onClick={() => setPicked([...new Set([...picked, ...shown.map((p) => p.playerId)])])}>Select all shown</button>
          <ul className="max-h-56 overflow-y-auto rounded-xl ring-1 ring-line">
            {shown.map((p) => (
              <li key={p.playerId}>
                <label className="flex items-center gap-2 px-3 py-2 text-[15px]">
                  <input type="checkbox" checked={picked.includes(p.playerId)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.playerId] : picked.filter((x) => x !== p.playerId))} />
                  {p.name} <span className="text-xs text-slate">{p.category}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        {error && <Notice tone="bad">{error}</Notice>}
        <button className="btn-primary" disabled={!picked.length}>Alert {picked.length || ""} parent{picked.length === 1 ? "" : "s"}</button>
      </form>
    </Modal>
  );
}
