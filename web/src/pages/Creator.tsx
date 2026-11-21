import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, Globe2, KeyRound, Search, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { openPreview, PORTAL_URL } from "../lib/portal";
import { PaymentConfiguration, PrivilegeControl } from "./Control";
import { api } from "../lib/api";
import { allowed, useAuth } from "../lib/auth";
import { AGE_GROUPS, dateTime12, money, WEEKDAYS } from "../lib/format";
import { Empty, ErrorNote, Modal, NameInput, Notice, PageTitle, Spinner, Tabs } from "../components/ui";
import { ChildDashboard, type Child } from "./Parent";

const ROLE_LABEL: Record<string, string> = { super_admin: "Super Admin", admin: "Admin", coach: "Coach", parent: "Parent" };
type Tab = "staff" | "parents" | "payments" | "privileges" | "places" | "impact" | "audit";

/**
 * Creator Control: Admins and Super Admins (equal powers).
 * Staff & Coaches and Parents are separate tabs, so the two never mix.
 */
export function CreatorControl() {
  const { me } = useAuth();
  const { tab } = useParams();
  const nav = useNavigate();
  if (!me?.isSuperAdmin) return <ErrorNote error={new Error("Creator Control is for Admins and Super Admins.")} />;
  // Each area follows the Super Admin's Privilege Control switches for this Admin.
  const tabs = ([
    allowed(me, "coaches.manage") && { id: "staff", label: "Staff & Coaches" },
    (allowed(me, "parents.manage") || allowed(me, "parents.preview")) && { id: "parents", label: "Parents" },
    { id: "payments", label: "Payments & registration" },
    me.isRealSuperAdmin && { id: "privileges", label: "Privilege Control" },
    allowed(me, "intramurals.edit") && { id: "places", label: "Countries & schools" },
    { id: "impact", label: "Impact" },
    { id: "audit", label: "Activity log" },
  ].filter(Boolean)) as { id: Tab; label: string }[];
  const current = (tabs.find((t) => t.id === tab)?.id ?? tabs[0].id) as Tab;
  return (
    <>
      <PageTitle banner title="Creator Control" sub="Staff, coaches, parents, payments and schools across Ambassadors Football." />
      <Tabs tabs={tabs} value={current} onChange={(t) => nav(`/creator/${t}`, { replace: true })} />
      {current === "staff" && <Staff />}
      {current === "parents" && <Parents />}
      {current === "payments" && <PaymentConfiguration />}
      {current === "privileges" && <PrivilegeControl />}
      {current === "places" && <Places />}
      {current === "impact" && <Impact />}
      {current === "audit" && <Audit />}
    </>
  );
}

function useCountries() {
  return useQuery({ queryKey: ["creator-countries"], queryFn: () => api<any[]>("/creator/countries") });
}
function useAllIntramurals() {
  return useQuery({ queryKey: ["intramurals"], queryFn: () => api<any[]>("/intramurals") });
}

// ---- Staff & Coaches ----------------------------------------------------------------------

function Staff() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["creator-users", "staff"], queryFn: () => api<any[]>("/creator/users?kind=staff") });
  const intramurals = useAllIntramurals();
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [open, setOpen] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  const names = new Map((intramurals.data ?? []).map((i) => [i.id, i.shortCode ?? i.name]));
  const list = useMemo(() => (users.data ?? []).filter((u) =>
    (!role || u.role === role) && `${u.name} ${u.email} ${u.phone ?? ""}`.toLowerCase().includes(q.toLowerCase())), [users.data, q, role]);
  if (users.isLoading) return <Spinner />;
  if (users.error) return <ErrorNote error={users.error} />;
  return (
    <>
      <p className="mb-3 rounded-xl bg-white p-3 text-sm text-slate ring-1 ring-line"><ShieldCheck className="mr-1 inline h-4 w-4" /> Admins and Super Admins have exactly the same powers in every school and club.</p>
      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <div className="relative"><Search className="pointer-events-none absolute left-3 top-3 h-5 w-5 text-slate" aria-hidden /><input className="field pl-10" placeholder="Search name, email or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search staff" /></div>
        <select className="field" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role"><option value="">All roles</option><option value="super_admin">Super Admin</option><option value="admin">Admin</option><option value="coach">Coach</option></select>
        <button className="btn-primary" onClick={() => setCreating(true)}><UserPlus className="h-4 w-4" /> Add a person</button>
      </div>
      <ul className="sheet divide-y divide-line py-1">
        {list.map((u) => (
          <li key={u.id}>
            <button className="flex w-full items-center gap-3 py-2.5 text-left" onClick={() => setOpen(u)}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold text-navy">{u.name}</p>
                <p className="truncate text-sm text-slate">
                  {u.email}
                  {u.role === "coach" && u.assignments.length > 0 && ` · ${u.assignments.map((a: any) => `${names.get(a.intramuralId) ?? "?"}${a.ageGroups.length ? ` ${a.ageGroups.join("/")}` : ""}`).join(", ")}`}
                  {u.role === "coach" && u.assignments.length === 0 && " · not assigned yet"}
                </p>
              </div>
              {u.status !== "active" && <span className={`chip ${u.status === "pending" ? "bg-warn/15 text-warn" : "bg-bad/10 text-bad"}`}>{u.status}</span>}
              <span className={`chip ${u.role === "super_admin" ? "bg-navy text-white" : u.role === "admin" ? "bg-brand/10 text-brand" : "bg-page text-slate"}`}>{ROLE_LABEL[u.role]}</span>
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="py-3 text-slate">Nobody matches.</li>}
      </ul>
      {open && <StaffEditor user={open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); void qc.invalidateQueries({ queryKey: ["creator-users"] }); }} />}
      {creating && <CreatePerson kind="staff" onClose={() => setCreating(false)} onSaved={() => void qc.invalidateQueries({ queryKey: ["creator-users"] })} />}
    </>
  );
}

/** Pick schools/clubs and, for each, the age groups (none ticked = all ages). */
export function AssignmentPicker({ value, onChange, intramurals }: {
  value: { intramuralId: number; ageGroups: string[] }[];
  onChange: (v: { intramuralId: number; ageGroups: string[] }[]) => void;
  intramurals: any[];
}) {
  const byId = new Map(value.map((a) => [a.intramuralId, a]));
  return (
    <div className="grid gap-2">
      {intramurals.map((i) => {
        const a = byId.get(i.id);
        return (
          <div key={i.id} className={`rounded-xl p-3 ring-1 ${a ? "bg-brand/5 ring-brand/40" : "ring-line"}`}>
            <label className="flex items-center gap-2 text-[15px] font-semibold">
              <input type="checkbox" className="h-4 w-4" checked={!!a}
                onChange={(e) => onChange(e.target.checked ? [...value, { intramuralId: i.id, ageGroups: [] }] : value.filter((x) => x.intramuralId !== i.id))} />
              {i.name} <span className="text-xs font-normal text-slate">{i.countryName} · {WEEKDAYS[i.sessionWeekday]}s</span>
            </label>
            {a && (
              <div className="mt-2 flex flex-wrap gap-1 pl-6" role="group" aria-label={`Age groups at ${i.name}`}>
                {AGE_GROUPS.map((g) => {
                  const on = a.ageGroups.includes(g);
                  return (
                    <button type="button" key={g} aria-pressed={on}
                      onClick={() => onChange(value.map((x) => x.intramuralId === i.id ? { ...x, ageGroups: on ? x.ageGroups.filter((y) => y !== g) : [...x.ageGroups, g] } : x))}
                      className={`rounded-full px-2.5 py-1 text-xs font-bold ring-1 ${on ? "bg-navy text-white ring-navy" : "text-slate ring-line"}`}>{g}</button>
                  );
                })}
                <span className="self-center pl-1 text-xs text-slate">{a.ageGroups.length ? "" : "All ages"}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StaffEditor({ user, onClose, onSaved }: { user: any; onClose: () => void; onSaved: () => void }) {
  const { me } = useAuth();
  const countries = useCountries();
  const intramurals = useAllIntramurals();
  const [role, setRole] = useState(user.role);
  const [status, setStatus] = useState(user.status);
  const [countryId, setCountryId] = useState(user.countryId ?? 0);
  const [assignments, setAssignments] = useState<{ intramuralId: number; ageGroups: string[] }[]>(user.assignments ?? []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const self = user.id === me!.id;
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (role !== user.role || status !== user.status || countryId !== user.countryId) {
        await api(`/creator/users/${user.id}`, { method: "PATCH", body: { ...(role !== user.role ? { role } : {}), ...(status !== user.status ? { status } : {}), ...(countryId && countryId !== user.countryId ? { countryId } : {}) } });
      }
      await api(`/creator/users/${user.id}/assignments`, { method: "PUT", body: { assignments } });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove ${user.name}'s account? This cannot be undone.`)) return;
    try { await api(`/creator/users/${user.id}`, { method: "DELETE" }); onSaved(); } catch (err) { setError((err as Error).message); }
  };
  return (
    <Modal open onClose={onClose} title={user.name}>
      <p className="-mt-2 mb-4 text-sm text-slate">{user.email}{user.phone ? ` · ${user.phone}` : ""}</p>
      {user.isCreator && <p className="mb-3 rounded-xl bg-page p-3 text-sm text-slate"><ShieldCheck className="mr-1 inline h-4 w-4" />The founder's account. Its role can't be changed.</p>}
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="ur">Role</label>
            <select id="ur" className="field" value={role} disabled={user.isCreator || self} onChange={(e) => setRole(e.target.value)}>
              <option value="super_admin">Super Admin</option><option value="admin">Admin</option><option value="coach">Coach</option>
            </select>
          </div>
          <div><label className="label" htmlFor="us">Status</label>
            <select id="us" className="field" value={status} disabled={user.isCreator || self} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Active</option><option value="pending">Pending</option><option value="suspended">Suspended</option>
            </select>
          </div>
        </div>
        <div><label className="label" htmlFor="uc">Country</label>
          <select id="uc" className="field" value={countryId} onChange={(e) => setCountryId(Number(e.target.value))}>
            {(countries.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {role === "coach" ? (
          <fieldset>
            <legend className="label">Coaches at</legend>
            <AssignmentPicker value={assignments} onChange={setAssignments} intramurals={intramurals.data ?? []} />
          </fieldset>
        ) : (
          <p className="rounded-xl bg-page p-3 text-sm text-slate">{ROLE_LABEL[role]}s work across every school and club.</p>
        )}
        {error && <Notice tone="bad">{error}</Notice>}
        <button className="btn-primary" disabled={busy} onClick={save}>Save changes</button>
        <TempPassword userId={user.id} name={user.name} />
        {!user.isCreator && !self && <button className="btn-ghost text-bad" onClick={remove}><Trash2 className="h-4 w-4" /> Remove</button>}
      </div>
    </Modal>
  );
}

/** Set a temporary password (typed, or generated). The person chooses their own at next sign-in. */
function TempPassword({ userId, name }: { userId: number; name: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const submit = async () => {
    setError("");
    try {
      const r = await api<{ temporaryPassword: string }>(`/creator/users/${userId}/password`, { method: "POST", body: value ? { password: value } : {} });
      setResult(r.temporaryPassword);
      setValue("");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (!open) return <button className="btn-ghost" onClick={() => setOpen(true)}><KeyRound className="h-4 w-4" /> Set temporary password</button>;
  return (
    <div className="rounded-xl p-3 ring-1 ring-line">
      {result ? (
        <>
          <p className="text-sm">New temporary password for {name.split(" ")[0]}. Share it privately; they'll choose their own when they sign in.</p>
          <p className="display mt-2 select-all rounded-lg bg-page p-3 text-center text-2xl tracking-wide">{result}</p>
        </>
      ) : (
        <>
          <label className="label" htmlFor={`tp-${userId}`}>Temporary password</label>
          <input id={`tp-${userId}`} className="field" placeholder="Leave empty to generate one" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
          {error && <Notice tone="bad">{error}</Notice>}
          <button className="btn-primary mt-2 w-full" onClick={submit}>Set password</button>
        </>
      )}
    </div>
  );
}

function CreatePerson({ kind, onClose, onSaved }: { kind: "staff" | "parent"; onClose: () => void; onSaved: () => void }) {
  const countries = useCountries();
  const intramurals = useAllIntramurals();
  const [f, setF] = useState({ name: "", email: "", phone: "", role: "coach", countryId: 0, password: "" });
  const [assignments, setAssignments] = useState<{ intramuralId: number; ageGroups: string[] }[]>([]);
  const [children, setChildren] = useState<number[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState("");
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const countryId = f.countryId || countries.data?.[0]?.id;
      if (kind === "parent") {
        const r = await api<{ temporaryPassword: string }>("/creator/parents", { method: "POST", body: { name: f.name, email: f.email, phone: f.phone, countryId, password: f.password || undefined, playerIds: children } });
        setResult(r.temporaryPassword);
      } else {
        const r = await api<{ id: number; temporaryPassword: string }>("/creator/users", { method: "POST", body: { name: f.name, email: f.email, phone: f.phone, role: f.role, countryId, password: f.password || undefined } });
        if (f.role === "coach" && assignments.length) await api(`/creator/users/${r.id}/assignments`, { method: "PUT", body: { assignments } });
        setResult(r.temporaryPassword);
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal open onClose={onClose} title={kind === "parent" ? "Add a parent" : "Add a person"}>
      {result ? (
        <div className="grid gap-3">
          <p className="text-[15px]">Account created. Share this temporary password with {f.name.split(" ")[0]} privately. They'll choose their own when they first sign in.</p>
          <p className="display select-all rounded-xl bg-page p-4 text-center text-3xl tracking-wide">{result}</p>
          <p className="text-sm text-slate">They sign in with {f.email} or their phone number.</p>
          <button className="btn-primary" onClick={onClose}>Done</button>
        </div>
      ) : (
        <form onSubmit={save} className="grid gap-3">
          <div><label className="label" htmlFor="cn">Full name</label><NameInput id="cn" value={f.name} onChange={(v) => setF({ ...f, name: v })} required /></div>
          <div><label className="label" htmlFor="cp">Phone</label><input id="cp" type="tel" className="field" placeholder="0712 345 678" required={kind === "parent"} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          <div><label className="label" htmlFor="ce">Email</label><input id="ce" type="email" className="field" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            {kind === "staff" && (
              <div><label className="label" htmlFor="crole">Role</label>
                <select id="crole" className="field" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="coach">Coach</option><option value="admin">Admin</option><option value="super_admin">Super Admin</option></select>
              </div>
            )}
            <div><label className="label" htmlFor="ccountry">Country</label>
              <select id="ccountry" className="field" value={f.countryId} onChange={(e) => setF({ ...f, countryId: Number(e.target.value) })}>{(countries.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </div>
          </div>
          {kind === "staff" && f.role === "coach" && (
            <fieldset><legend className="label">Coaches at</legend><AssignmentPicker value={assignments} onChange={setAssignments} intramurals={intramurals.data ?? []} /></fieldset>
          )}
          {kind === "parent" && <ChildPicker value={children} onChange={setChildren} />}
          <div><label className="label" htmlFor="cpw">Temporary password</label><input id="cpw" className="field" placeholder="Leave empty to generate one" autoComplete="off" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          {error && <Notice tone="bad">{error}</Notice>}
          <button className="btn-primary">Create account</button>
        </form>
      )}
    </Modal>
  );
}

// ---- Parents -----------------------------------------------------------------------------

function Parents() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const canPreview = allowed(me, "parents.preview");
  const canManage = allowed(me, "parents.manage");
  const viewAs = async (id: number) => {
    setPreviewError("");
    try {
      const r = await api<{ token: string }>(`/creator/parents/${id}/preview-token`, { method: "POST" });
      openPreview(r.token);
    } catch (e) {
      setPreviewError((e as Error).message);
    }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(PORTAL_URL); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* ignore */ }
  };
  const parents = useQuery({ queryKey: ["creator-parents"], queryFn: () => api<any[]>("/creator/parents"), enabled: canManage || canPreview });
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  if (parents.isLoading) return <Spinner />;
  if (parents.error) return <ErrorNote error={parents.error} />;
  const list = parents.data!.filter((p) => `${p.name} ${p.email} ${p.phone ?? ""} ${p.children.map((c: any) => c.name).join(" ")}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="sheet mb-4">
        <p className="font-bold text-navy">Parent portal link</p>
        <p className="text-sm text-slate">Parents sign in here, separately from coaches and admins. Share this link with them.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-page px-3 py-2 text-sm">{PORTAL_URL}</code>
          <button className="btn-ghost min-h-10" onClick={copy}><Copy className="h-4 w-4" /> {copied ? "Copied" : "Copy"}</button>
          <a className="btn-ghost min-h-10" href={`${PORTAL_URL}/`} target="_blank" rel="noopener">Open</a>
        </div>
        {canPreview && <p className="mt-2 text-sm text-slate">To see exactly what one parent sees, choose View as parent next to their name. It opens their portal read-only in a new tab for 30 minutes.</p>}
        {previewError && <Notice tone="bad">{previewError}</Notice>}
      </div>
      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_auto]">
        <div className="relative"><Search className="pointer-events-none absolute left-3 top-3 h-5 w-5 text-slate" aria-hidden /><input className="field pl-10" placeholder="Search parent or child" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search parents" /></div>
        {canManage && <button className="btn-primary" onClick={() => setCreating(true)}><UserPlus className="h-4 w-4" /> Add a parent</button>}
      </div>
      {list.length === 0 ? <Empty>No parents yet. Add one, or they can sign up themselves.</Empty> : (
        <ul className="grid gap-2">
          {list.map((p) => (
            <li key={p.id} className="sheet">
              <div className="flex items-start gap-3">
                <button className="min-w-0 flex-1 text-left" onClick={() => canManage && setOpen(p)}>
                  <p className="font-bold text-navy">{p.name} {p.status !== "active" && <span className={`chip ml-1 ${p.status === "pending" ? "bg-warn/15 text-warn" : "bg-bad/10 text-bad"}`}>{p.status}</span>}</p>
                  <p className="truncate text-sm text-slate">{p.phone ?? "No phone"} · {p.email}</p>
                  <p className="mt-1 text-sm">
                    {p.children.length ? p.children.map((c: any) => `${c.name} (${c.category || "?"}, ${c.intramuralName})${c.verified ? "" : " · to confirm"}`).join("; ") : <span className="text-slate">No children linked</span>}
                  </p>
                </button>
                {canPreview && (
                  <button onClick={() => viewAs(p.id)} className="btn-ghost min-h-9 shrink-0 px-3" aria-label={`View as ${p.name}`}><Eye className="h-4 w-4" /> View as parent</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {open && <ParentEditor parent={open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); void qc.invalidateQueries({ queryKey: ["creator-parents"] }); }} />}
      {creating && <CreatePerson kind="parent" onClose={() => setCreating(false)} onSaved={() => void qc.invalidateQueries({ queryKey: ["creator-parents"] })} />}
    </>
  );
}

/** Search players and tick the parent's children. */
function ChildPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const [q, setQ] = useState("");
  const players = useQuery({ queryKey: ["creator-players", q], queryFn: () => api<any[]>(`/creator/players?q=${encodeURIComponent(q)}`) });
  const chosen = useQuery({ queryKey: ["creator-players", ""], queryFn: () => api<any[]>(`/creator/players?q=`) });
  const names = new Map((chosen.data ?? []).concat(players.data ?? []).map((p) => [p.id, p]));
  return (
    <fieldset>
      <legend className="label">Children</legend>
      {value.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {value.map((id) => (
            <button type="button" key={id} onClick={() => onChange(value.filter((x) => x !== id))} className="chip bg-navy py-1 text-white">
              {names.get(id)?.name ?? `Player ${id}`} ✕
            </button>
          ))}
        </div>
      )}
      <input className="field" placeholder="Search a child or guardian name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search children" />
      <ul className="mt-2 max-h-48 overflow-y-auto rounded-xl ring-1 ring-line">
        {(players.data ?? []).filter((p) => !value.includes(p.id)).slice(0, 30).map((p) => (
          <li key={p.id}>
            <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-page" onClick={() => onChange([...value, p.id])}>
              <span><span className="font-semibold">{p.name}</span> <span className="text-slate">{p.category} · {p.intramuralName}</span></span>
              <span className="text-xs text-slate">{p.guardianName}</span>
            </button>
          </li>
        ))}
        {(players.data ?? []).length === 0 && <li className="px-3 py-2 text-sm text-slate">No players found.</li>}
      </ul>
    </fieldset>
  );
}

function ParentEditor({ parent, onClose, onSaved }: { parent: any; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: parent.name, email: parent.email, phone: parent.phone ?? "", status: parent.status });
  const [children, setChildren] = useState<number[]>(parent.children.map((c: any) => c.playerId));
  const [error, setError] = useState("");
  const save = async () => {
    setError("");
    try {
      await api(`/creator/parents/${parent.id}`, { method: "PATCH", body: f });
      await api(`/creator/parents/${parent.id}/children`, { method: "PUT", body: { playerIds: children } });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove ${parent.name}'s parent account? Their children's records stay.`)) return;
    try { await api(`/creator/users/${parent.id}`, { method: "DELETE" }); onSaved(); } catch (err) { setError((err as Error).message); }
  };
  return (
    <Modal open onClose={onClose} title={parent.name}>
      <div className="grid gap-3">
        <div><label className="label" htmlFor="pn">Name</label><NameInput id="pn" value={f.name} onChange={(v) => setF({ ...f, name: v })} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="pph">Phone</label><input id="pph" type="tel" className="field" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          <div><label className="label" htmlFor="pst">Status</label>
            <select id="pst" className="field" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="active">Active</option><option value="pending">Pending</option><option value="suspended">Suspended</option></select>
          </div>
        </div>
        <div><label className="label" htmlFor="pem">Email</label><input id="pem" type="email" className="field" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        <ChildPicker value={children} onChange={setChildren} />
        {error && <Notice tone="bad">{error}</Notice>}
        <button className="btn-primary" onClick={save}>Save parent</button>
        <TempPassword userId={parent.id} name={parent.name} />
        <button className="btn-ghost text-bad" onClick={remove}><Trash2 className="h-4 w-4" /> Remove parent account</button>
      </div>
    </Modal>
  );
}

/** Admin's read-only view of what a parent sees. */
export function ParentPreview() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ["parent-preview", id], queryFn: () => api<{ parent: { name: string }; children: Child[] }>(`/creator/parents/${id}/children`) });
  const [selected, setSelected] = useState<number | null>(null);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { parent, children } = q.data!;
  const child = children.find((c) => c.id === selected) ?? children[0];
  return (
    <div className="parent-3d">
      <p className="mb-3 rounded-xl bg-warn/15 p-3 text-sm font-semibold text-warn">Preview: this is what {parent.name} sees. Nothing here can be changed.</p>
      <PageTitle banner title={`${parent.name.split(" ")[0]}'s dashboard`} sub={<Link to="/creator/parents" className="underline">Back to Parents</Link>} />
      {children.length > 1 && (
        <div className="-mx-4 mb-2 flex gap-3 overflow-x-auto px-4 pb-6 pt-2" role="tablist">
          {children.map((c) => (
            <button key={c.id} role="tab" aria-selected={c.id === child.id} onClick={() => setSelected(c.id)} className="token flex items-center gap-2 whitespace-nowrap rounded-full py-1.5 pl-1.5 pr-4 text-[15px] font-semibold text-navy">
              <span className="bead grid h-8 w-8 place-items-center rounded-full text-sm text-white" style={{ background: c.color }}>{c.firstName[0]}</span>{c.firstName}
            </button>
          ))}
        </div>
      )}
      {child ? <ChildDashboard key={child.id} child={child} preview /> : <Empty>No confirmed children yet.</Empty>}
    </div>
  );
}

function Impact() {
  const q = useQuery({ queryKey: ["metrics"], queryFn: () => api<any[]>("/creator/metrics") });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  const total = (k: string) => q.data!.reduce((s, c) => s + Number(c[k] ?? 0), 0);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[["Players", total("players")], ["Coaches", total("coaches")], ["Schools & clubs", total("intramurals")], ["Mentorship logs", total("mentorshipLogs")]].map(([l, v]) => (
          <div key={l} className="sheet"><p className="display text-[2.4rem] text-navy">{Number(v).toLocaleString()}</p><p className="text-sm text-slate">{l}</p></div>
        ))}
      </div>
      <h2 className="condensed mb-2 mt-6 text-lg text-navy">By country</h2>
      <div className="sheet overflow-x-auto p-0">
        <table className="w-full min-w-[640px] text-left text-[14px]">
          <thead className="text-slate"><tr className="border-b border-line">{["Country", "Schools", "Players", "Coaches", "Parents", "Sessions (30 days)", "Attendance (90 days)", "Virtue avg", "Collected"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
          <tbody>
            {q.data!.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0">
                <th scope="row" className="px-3 py-2 font-bold text-navy"><Globe2 className="mr-1 inline h-4 w-4 text-slate" aria-hidden />{c.name}</th>
                <td className="px-3 py-2">{c.intramurals}</td><td className="px-3 py-2">{c.players}</td><td className="px-3 py-2">{c.coaches}</td><td className="px-3 py-2">{c.parents}</td>
                <td className="px-3 py-2">{c.sessions30d}</td><td className="px-3 py-2">{c.attendanceRate90d == null ? "—" : `${c.attendanceRate90d}%`}</td>
                <td className="px-3 py-2">{c.virtueAverage ?? "—"}</td><td className="px-3 py-2">{money(c.collected, c.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Places() {
  const qc = useQueryClient();
  const countries = useCountries();
  const intramurals = useAllIntramurals();
  const [c, setC] = useState({ code: "", name: "", currency: "", timeZone: "", phonePrefix: "+", mpesa: false });
  const [i, setI] = useState({ countryId: 0, name: "", shortCode: "", kind: "intramural", sessionWeekday: 2 });
  const [msg, setMsg] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const addCountry = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api("/creator/countries", { method: "POST", body: c }); setMsg({ tone: "good", text: `${c.name} added.` }); setC({ code: "", name: "", currency: "", timeZone: "", phonePrefix: "+", mpesa: false }); void qc.invalidateQueries({ queryKey: ["creator-countries"] }); }
    catch (err) { setMsg({ tone: "bad", text: (err as Error).message }); }
  };
  const addIntramural = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api("/creator/intramurals", { method: "POST", body: { ...i, countryId: i.countryId || countries.data?.[0]?.id } }); setMsg({ tone: "good", text: `${i.name} added. Assign an admin to it under People.` }); setI({ ...i, name: "", shortCode: "" }); void qc.invalidateQueries({ queryKey: ["intramurals"] }); }
    catch (err) { setMsg({ tone: "bad", text: (err as Error).message }); }
  };
  const toggle = async (country: any, key: "active" | "mpesa") => {
    await api(`/creator/countries/${country.id}`, { method: "PATCH", body: { [key]: !country[key] } });
    void qc.invalidateQueries({ queryKey: ["creator-countries"] });
  };
  return (
    <>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <h2 className="condensed mb-2 mt-2 text-lg text-navy">Countries</h2>
      <ul className="sheet divide-y divide-line py-1">
        {(countries.data ?? []).map((ct) => (
          <li key={ct.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <span className="flex-1 font-bold text-navy">{ct.name} <span className="text-sm font-normal text-slate">{ct.code} · {ct.currency} · {ct.timeZone} · {ct.phonePrefix}</span></span>
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={ct.mpesa} onChange={() => toggle(ct, "mpesa")} /> M-PESA</label>
            <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={ct.active} onChange={() => toggle(ct, "active")} /> Open for sign-up</label>
          </li>
        ))}
      </ul>
      <form onSubmit={addCountry} className="sheet mt-3 grid gap-3">
        <p className="font-bold text-navy">Add a country</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <input className="field" placeholder="Name, e.g. Uganda" aria-label="Country name" required value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
          <input className="field" placeholder="Code, e.g. UG" aria-label="Country code" maxLength={2} required value={c.code} onChange={(e) => setC({ ...c, code: e.target.value.toUpperCase() })} />
          <input className="field" placeholder="Currency, e.g. UGX" aria-label="Currency" maxLength={3} required value={c.currency} onChange={(e) => setC({ ...c, currency: e.target.value.toUpperCase() })} />
          <input className="field" placeholder="Time zone, e.g. Africa/Kampala" aria-label="Time zone" required value={c.timeZone} onChange={(e) => setC({ ...c, timeZone: e.target.value })} />
          <input className="field" placeholder="Phone prefix, e.g. +256" aria-label="Phone prefix" required value={c.phonePrefix} onChange={(e) => setC({ ...c, phonePrefix: e.target.value })} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={c.mpesa} onChange={(e) => setC({ ...c, mpesa: e.target.checked })} /> M-PESA available</label>
        </div>
        <button className="btn-primary justify-self-start">Add country</button>
      </form>

      <h2 className="condensed mb-2 mt-6 text-lg text-navy">Schools and clubs</h2>
      {(intramurals.data ?? []).length === 0 ? <Empty>None yet.</Empty> : (
        <ul className="sheet divide-y divide-line py-1">
          {intramurals.data!.map((x) => <li key={x.id} className="py-2 text-[15px]"><span className="font-semibold">{x.name}</span> <span className="text-sm text-slate">{x.countryName} · {x.dayLabel}</span></li>)}
        </ul>
      )}
      <form onSubmit={addIntramural} className="sheet mt-3 grid gap-3">
        <p className="font-bold text-navy">Add a school intramural or club</p>
        <div className="grid grid-cols-2 gap-3">
          <input className="field" placeholder="Name" aria-label="Name" required value={i.name} onChange={(e) => setI({ ...i, name: e.target.value })} />
          <input className="field" placeholder="Short code, e.g. KH" aria-label="Short code" maxLength={6} required value={i.shortCode} onChange={(e) => setI({ ...i, shortCode: e.target.value })} />
          <select className="field" aria-label="Country" value={i.countryId} onChange={(e) => setI({ ...i, countryId: Number(e.target.value) })}>{(countries.data ?? []).map((ct) => <option key={ct.id} value={ct.id}>{ct.name}</option>)}</select>
          <select className="field" aria-label="Kind" value={i.kind} onChange={(e) => setI({ ...i, kind: e.target.value })}><option value="intramural">Intramural</option><option value="club">Club</option></select>
          <select className="field" aria-label="Session day" value={i.sessionWeekday} onChange={(e) => setI({ ...i, sessionWeekday: Number(e.target.value) })}>{WEEKDAYS.map((d, n) => <option key={d} value={n}>{d}s</option>)}</select>
        </div>
        <button className="btn-primary justify-self-start">Add</button>
      </form>
    </>
  );
}

function Audit() {
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api<any[]>("/creator/audit") });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} />;
  return (
    <ul className="sheet divide-y divide-line py-1">
      {q.data!.map((a) => (
        <li key={a.id} className="py-2 text-[14px]">
          <span className="font-semibold">{a.actor ?? "System"}</span> · {a.action.replace(/_/g, " ")} <span className="text-xs text-slate">{dateTime12(a.createdAt)}</span>
          <span className="block truncate text-xs text-slate">{JSON.stringify(a.detail)}</span>
        </li>
      ))}
    </ul>
  );
}
