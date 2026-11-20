import { useEffect, useRef, type ReactNode } from "react";
import { LoaderCircle, X } from "lucide-react";
import type { Session } from "../lib/queries";
import { relativeDay, shortDate, time12 } from "../lib/format";

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-slate" role="status">
      <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div role="alert" className="sheet text-center">
      <p className="font-semibold text-bad">{message}</p>
      {onRetry && <button className="btn-ghost mt-3" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Notice({ tone, children }: { tone: "good" | "bad"; children: ReactNode }) {
  return (
    <p role={tone === "bad" ? "alert" : "status"} className={`mt-2 text-sm font-semibold ${tone === "good" ? "text-good" : "text-bad"}`}>
      {children}
    </p>
  );
}

export function PageTitle({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="display text-[2.1rem] text-navy sm:text-[2.6rem]">{title}</h1>
        {sub && <p className="mt-1.5 text-[15px] text-slate">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 mt-7 flex items-center justify-between gap-3">
      <h2 className="condensed text-lg text-navy">{children}</h2>
      {action}
    </div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-[22px] border border-dashed border-line px-5 py-8 text-center text-[15px] text-slate">
      {children}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** A school's logo on a white tile, or its initials in its colour. */
export function Crest({ i, size = 40 }: { i: { logo?: string; shortCode: string; color: string; name: string }; size?: number }) {
  const style = { width: size, height: size };
  if (i.logo) {
    return (
      <span className="grid shrink-0 place-items-center overflow-hidden rounded-lg bg-white p-0.5 ring-1 ring-line" style={style}>
        <img src={`/${i.logo}`} alt="" className="h-full w-full object-contain" />
      </span>
    );
  }
  return (
    <span className="grid shrink-0 place-items-center rounded-lg text-xs font-bold text-white" style={{ ...style, backgroundColor: i.color }} aria-hidden>
      {i.shortCode}
    </span>
  );
}

/**
 * The fixture board: the next session as a stadium board would show it.
 * The one bold element of the design.
 */
export function FixtureBoard({ s, title, footer }: { s: Session; title?: ReactNode; footer?: ReactNode }) {
  const label =
    s.kind === "match" ? `Match${s.opponent ? ` vs ${s.opponent}` : ""}` : s.kind === "tournament" ? s.title || "Tournament" : `${s.dayLabel} session`;
  return (
    <div className="fixture relative overflow-hidden rounded-[26px] bg-navy text-white">
      {/* centre circle and halfway line, like the pitch */}
      <svg className="pointer-events-none absolute -right-16 -top-10 h-64 w-64 opacity-[0.09]" viewBox="0 0 200 200" aria-hidden>
        <circle cx="100" cy="100" r="70" fill="none" stroke="white" strokeWidth="3" />
        <line x1="100" y1="0" x2="100" y2="200" stroke="white" strokeWidth="3" />
        <circle cx="100" cy="100" r="4" fill="white" />
      </svg>
      <div className="relative p-5">
        <div className="flex items-center justify-between gap-2 text-[13px] font-semibold text-white/75">
          <span>{title ?? s.intramuralName}</span>
          {s.cancelled ? <span className="chip bg-bad text-white">Cancelled</span> : <span>{shortDate(s.date)}</span>}
        </div>
        <div className="mt-3 flex items-end gap-4">
          <div className="extrude-day display text-[3.4rem] sm:text-[4.2rem]">{relativeDay(s.date)}</div>
        </div>
        <div className="extrude-time display mt-1 text-[2.2rem] text-[#9fb6ff] sm:text-[2.6rem]">
          {time12(s.startTime)} <span className="text-white/40">–</span> {time12(s.endTime)}
        </div>
        <p className="mt-3 text-[15px] font-semibold">{label}</p>
        {(s.location || s.dressCode) && (
          <dl className="mt-2 grid gap-1 text-[14px] text-white/80">
            {s.location && <div><dt className="sr-only">Pitch</dt><dd>Pitch: {s.location}</dd></div>}
            {s.dressCode && <div><dt className="sr-only">Kit</dt><dd>Kit: {s.dressCode}</dd></div>}
          </dl>
        )}
        {footer && <div className="mt-4">{footer}</div>}
      </div>
    </div>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className="m-0 mt-auto w-full max-w-none rounded-t-[26px] bg-white p-0 text-ink backdrop:bg-navy/50 sm:m-auto sm:max-w-md sm:rounded-[26px]"
    >
      {open && (
        <div className="max-h-[88vh] overflow-y-auto p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="condensed text-xl text-navy">{title}</h2>
            <button className="rounded-full p-2 hover:bg-page" onClick={onClose} aria-label="Close"><X className="h-5 w-5" /></button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

/** Text input that Title-Cases names as they are typed. */
export function NameInput(props: { value: string; onChange: (v: string) => void; id?: string; required?: boolean; placeholder?: string; autoComplete?: string }) {
  return (
    <input
      id={props.id}
      className="field"
      value={props.value}
      required={props.required}
      placeholder={props.placeholder}
      autoComplete={props.autoComplete ?? "name"}
      autoCapitalize="words"
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={(e) => props.onChange(titleCaseKeep(e.target.value))}
    />
  );
}

function titleCaseKeep(v: string) {
  return v.trim().replace(/\s+/g, " ").toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (_m, s: string, c: string) => s + c.toUpperCase()).replace(/\bMc(\p{L})/gu, (_m, c: string) => "Mc" + c.toUpperCase());
}

export function PendingBadge() {
  return <span className="chip bg-warn/15 text-warn">Pending sync</span>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div role="tablist" className="-mx-4 mb-4 flex gap-1 overflow-x-auto px-4 pb-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          ref={value === t.id ? (el) => el?.scrollIntoView({ block: "nearest", inline: "center" }) : undefined}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-semibold ${value === t.id ? "bg-navy text-white" : "bg-white text-slate ring-1 ring-line"}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
