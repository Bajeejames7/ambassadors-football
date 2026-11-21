import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { api } from "../lib/api";
import { useIntramural, type Intramural } from "../lib/queries";
import { AGE_GROUPS, WEEKDAYS } from "../lib/format";
import { Modal, Notice, Spinner } from "./ui";
import { Coaches } from "../pages/Admin";

/** The Edit button's form: a pre-filled sheet for one school or club. */
export function EditIntramuralModal({ id, open, onClose }: { id: number; open: boolean; onClose: () => void }) {
  const q = useIntramural(open ? id : 0);
  return (
    <Modal open={open} onClose={onClose} title="Edit school or club">
      {!open ? null : q.data ? <EditForm i={q.data} onClose={onClose} /> : <Spinner />}
    </Modal>
  );
}

function EditForm({ i, onClose }: { i: Intramural; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: i.name,
    location: i.location,
    sessionWeekday: i.sessionWeekday,
    sessionStart: i.sessionStart,
    sessionEnd: i.sessionEnd,
    termStart: i.termStart ?? "",
    termEnd: i.termEnd ?? "",
    categories: i.categories.filter((c) => (AGE_GROUPS as string[]).includes(c)),
    programMode: i.programMode,
    teams: i.teams.length ? i.teams : [
      { id: "temperance", name: "Temperance", color: "#2F5BD3" }, { id: "wisdom", name: "Wisdom", color: "#13996B" },
      { id: "fortitude", name: "Fortitude", color: "#D23B2A" }, { id: "justice", name: "Justice", color: "#C98213" },
    ],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const canCoaches = i.myPermissions.includes("roles.assign");

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/intramurals/${i.id}`, {
        method: "PATCH",
        body: {
          name: f.name, location: f.location, sessionWeekday: Number(f.sessionWeekday), sessionStart: f.sessionStart, sessionEnd: f.sessionEnd,
          termStart: f.termStart || null, termEnd: f.termEnd || null, categories: f.categories, programMode: f.programMode,
          ...(f.programMode === "school" ? { teams: f.teams } : {}),
        },
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["intramurals"] }),
        qc.invalidateQueries({ queryKey: ["intramural", i.id] }),
        qc.invalidateQueries({ queryKey: ["upcoming"] }),
      ]);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-h-[75vh] overflow-y-auto pr-1">
    <form onSubmit={save} className="grid gap-4">
      <div>
        <label className="label" htmlFor="ei-name">Name</label>
        <input id="ei-name" className="field" value={f.name} onChange={(e) => set("name", e.target.value)} required minLength={2} />
      </div>
      <div>
        <label className="label" htmlFor="ei-venue">Venue</label>
        <input id="ei-venue" className="field" value={f.location} onChange={(e) => set("location", e.target.value)} placeholder="Rafiki main field" />
      </div>
      <fieldset>
        <legend className="label">Format</legend>
        <div className="grid grid-cols-2 gap-2">
          {([["school", "School · 4 Virtue Teams"], ["club", "Club · camps & events"]] as const).map(([v, label]) => (
            <label key={v} className={`cursor-pointer rounded-xl px-3 py-2.5 text-sm font-semibold ring-1 ${f.programMode === v ? "bg-navy text-white ring-navy" : "bg-white text-ink ring-line"}`}>
              <input type="radio" name="ei-mode" className="sr-only" checked={f.programMode === v} onChange={() => set("programMode", v)} /> {label}
            </label>
          ))}
        </div>
      </fieldset>
      {f.programMode === "school" && (
        <fieldset>
          <legend className="label">Virtue Teams</legend>
          <div className="grid grid-cols-2 gap-2">
            {f.teams.map((t, n) => (
              <div key={t.id} className="flex items-center gap-2">
                <input type="color" aria-label={`${t.name} colour`} value={t.color} className="h-9 w-9 shrink-0 rounded-lg border border-line"
                  onChange={(e) => set("teams", f.teams.map((x, k) => (k === n ? { ...x, color: e.target.value } : x)))} />
                <input className="field py-2" aria-label={`Team ${n + 1} name`} value={t.name}
                  onChange={(e) => set("teams", f.teams.map((x, k) => (k === n ? { ...x, name: e.target.value } : x)))} />
              </div>
            ))}
          </div>
        </fieldset>
      )}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="label" htmlFor="ei-day">Day</label>
          <select id="ei-day" className="field" value={f.sessionWeekday} onChange={(e) => set("sessionWeekday", Number(e.target.value))}>
            {WEEKDAYS.map((d, n) => <option key={d} value={n}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="ei-start">Starts</label>
          <input id="ei-start" type="time" className="field" value={f.sessionStart} onChange={(e) => set("sessionStart", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="ei-end">Ends</label>
          <input id="ei-end" type="time" className="field" value={f.sessionEnd} onChange={(e) => set("sessionEnd", e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label" htmlFor="ei-ts">{f.programMode === "club" ? "Season or camp starts" : "Term starts"}</label>
          <input id="ei-ts" type="date" className="field" value={f.termStart} onChange={(e) => set("termStart", e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="ei-te">{f.programMode === "club" ? "Ends" : "Term ends"}</label>
          <input id="ei-te" type="date" className="field" value={f.termEnd} onChange={(e) => set("termEnd", e.target.value)} />
        </div>
      </div>
      <fieldset>
        <legend className="label">Age groups</legend>
        <div className="flex flex-wrap gap-2">
          {AGE_GROUPS.map((g) => {
            const on = f.categories.includes(g);
            return (
              <button key={g} type="button" aria-pressed={on}
                onClick={() => set("categories", on ? f.categories.filter((c) => c !== g) : AGE_GROUPS.filter((a) => a === g || f.categories.includes(a)))}
                className={`rounded-full px-3 py-1.5 text-sm font-bold ring-1 ${on ? "bg-navy text-white ring-navy" : "bg-white text-slate ring-line"}`}>
                {g}
              </button>
            );
          })}
        </div>
      </fieldset>
      {error && <Notice tone="bad">{error}</Notice>}
      <button className="btn-primary h-12" disabled={busy}>{busy && <LoaderCircle className="h-4 w-4 animate-spin" />} Save changes</button>
    </form>
      {canCoaches && (
        <div className="mt-5 border-t border-line pt-4">
          <p className="mb-2 font-bold text-navy">Assigned coaches</p>
          <p className="mb-3 text-sm text-slate">Changes to coaches save straight away.</p>
          <Coaches i={i} />
        </div>
      )}
    </div>
  );
}
