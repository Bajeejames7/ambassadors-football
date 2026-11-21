import { useState } from "react";
import { Award, CalendarCheck2, MessageSquareQuote, Shield, Sparkles, Smartphone, UserRound } from "lucide-react";
import { money, shortDate, VIRTUE_LABELS } from "../lib/format";
import { MpesaModal } from "./MpesaModal";

/** Shape of GET /players/:id/overview. */
export interface Overview {
  player: {
    id: number; firstName: string; lastName: string; ageGroup: string; intramuralName: string; programMode: "school" | "club";
    team: { id: string; name: string; color: string } | null; termStart: string | null; termEnd: string | null;
  };
  coaches: string[];
  attendance: {
    attended: number; missed: number; excused: number; total: number;
    sessions: { sessionId: number; date: string; kind: string; title: string; status: string; injured: boolean }[];
  };
  timeline: { type: "feedback" | "award" | "virtue"; at: string; sessionDate: string | null; title: string; body: string; rating: number | null; coach: string | null }[];
  camps: { id: number; date: string; endDate: string | null; kind: string; title: string }[];
  payment: {
    currency: string; mpesaEnabled: boolean; termLabel: string; termFee: number | null; deadline: string | null;
    method: "paybill" | "till"; paybill: string; till: string; accountReference: string; instructions: string;
    charged: number; paid: number; balance: number; status: "none" | "paid" | "pending" | "partial" | "unpaid";
  };
}

/** Program, Virtue Team or camp, age group and coach. */
export function Placement({ o }: { o: Overview }) {
  const school = o.player.programMode === "school";
  const nextCamp = o.camps[0];
  return (
    <section aria-label="Program and team" className="sheet grid grid-cols-2 gap-x-4 gap-y-3">
      <Fact icon={Shield} label="Program">
        {school ? `${o.player.intramuralName} · 4 Virtue Teams` : `${o.player.intramuralName} · Club, camps & events`}
      </Fact>
      <Fact icon={Sparkles} label={school ? "Virtue Team" : "Next camp or event"}>
        {school ? (
          o.player.team ? (
            <span className="inline-flex items-center gap-2">
              <span className="h-3 w-3 rounded-full ring-2 ring-white" style={{ background: o.player.team.color }} aria-hidden />
              {o.player.team.name}
            </span>
          ) : "Not placed yet"
        ) : nextCamp ? `${nextCamp.title || nextCamp.kind}, ${shortDate(nextCamp.date)}` : "None booked yet"}
      </Fact>
      <Fact icon={CalendarCheck2} label="Age group">{o.player.ageGroup || "Not set"}</Fact>
      <Fact icon={UserRound} label={o.coaches.length > 1 ? "Coaches" : "Coach"}>
        {o.coaches.length ? o.coaches.slice(0, 3).join(", ") : "Being assigned"}
      </Fact>
    </section>
  );
}

function Fact({ icon: Icon, label, children }: { icon: typeof Shield; label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-slate"><Icon className="h-3.5 w-3.5" aria-hidden /> {label}</p>
      <p className="mt-0.5 text-[15px] font-bold leading-snug text-navy">{children}</p>
    </div>
  );
}

const STATUS = {
  attended: { label: "Attended", color: "var(--color-good)" },
  excused: { label: "Excused or injured", color: "var(--color-warn)" },
  missed: { label: "Missed", color: "var(--color-bad)" },
};

/** Attended vs missed vs excused, as one bar, then the dates. */
export function AttendanceCard({ o }: { o: Overview }) {
  const [all, setAll] = useState(false);
  const a = o.attendance;
  const rate = a.total ? Math.round((100 * a.attended) / a.total) : null;
  const list = all ? a.sessions : a.sessions.slice(0, 8);
  return (
    <section aria-label="Session attendance" className="sheet">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate">Session attendance</p>
          <p className="extrude display mt-1 text-[2.6rem] text-navy">{rate == null ? "None yet" : `${rate}%`}</p>
        </div>
        <p className="pb-2 text-right text-sm text-slate">{a.attended} of {a.total} sessions</p>
      </div>
      {a.total > 0 && (
        <>
          <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-page" role="img"
            aria-label={`Attended ${a.attended}, excused or injured ${a.excused}, missed ${a.missed}`}>
            {(["attended", "excused", "missed"] as const).map((k) =>
              a[k] > 0 ? <span key={k} style={{ width: `${(100 * a[k]) / a.total}%`, background: STATUS[k].color }} className="h-full first:rounded-l-full last:rounded-r-full [&+&]:ml-0.5" /> : null,
            )}
          </div>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {(["attended", "excused", "missed"] as const).map((k) => (
              <li key={k} className="flex items-center gap-1.5 text-ink">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS[k].color }} aria-hidden />
                {STATUS[k].label} <strong>{a[k]}</strong>
              </li>
            ))}
          </ul>
          <ul className="mt-4 divide-y divide-line border-t border-line">
            {list.map((s) => {
              const k = s.status === "present" || s.status === "late" ? "attended" : s.status === "excused" || s.injured ? "excused" : "missed";
              return (
                <li key={s.sessionId} className="flex items-center justify-between gap-3 py-2 text-[15px]">
                  <span>{shortDate(s.date)}{s.kind !== "training" ? ` · ${s.title || s.kind}` : ""}</span>
                  <span className="chip" style={{ color: STATUS[k].color, background: `color-mix(in srgb, ${STATUS[k].color} 12%, white)` }}>
                    {s.status === "late" ? "Late" : s.injured && k === "excused" ? "Injured" : STATUS[k].label.split(" ")[0]}
                  </span>
                </li>
              );
            })}
          </ul>
          {a.sessions.length > 8 && (
            <button className="mt-2 text-sm font-semibold text-brand" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${a.sessions.length} dates`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/** Coach notes, skill ratings and virtue milestones, newest first. */
export function CoachTimeline({ o }: { o: Overview }) {
  if (o.timeline.length === 0) {
    return <p className="sheet py-6 text-center text-[15px] text-slate">No coach notes yet. Coaches add them after sessions.</p>;
  }
  return (
    <ol className="sheet relative grid gap-4 pl-9">
      <span className="absolute bottom-5 left-[1.35rem] top-5 w-px bg-line" aria-hidden />
      {o.timeline.map((t, n) => {
        const Icon = t.type === "award" ? Award : t.type === "virtue" ? Sparkles : MessageSquareQuote;
        return (
          <li key={n} className="relative">
            <span className={`absolute -left-[1.85rem] top-0.5 grid h-6 w-6 place-items-center rounded-full ring-4 ring-white ${t.type === "feedback" ? "bg-brand" : "bg-warn"}`}>
              <Icon className="h-3.5 w-3.5 text-white" aria-hidden />
            </span>
            <p className="text-xs font-semibold text-slate">
              {shortDate(t.sessionDate ?? t.at.slice(0, 10))}{t.coach ? ` · ${t.coach}` : ""}
            </p>
            <p className="font-bold text-navy">
              {t.type === "virtue"
                ? `Virtue milestone: ${VIRTUE_LABELS[t.title as keyof typeof VIRTUE_LABELS] ?? t.title} ${t.rating}/10`
                : t.type === "award" ? t.title : `${t.title}${t.rating ? ` · ${"★".repeat(t.rating)}${"☆".repeat(5 - t.rating)}` : ""}`}
            </p>
            {t.body && <p className="text-[15px] text-ink">{t.body}</p>}
          </li>
        );
      })}
    </ol>
  );
}

const PAY_STATUS = {
  paid: { label: "Paid", cls: "bg-good/12 text-good" },
  pending: { label: "Payment in progress", cls: "bg-brand/10 text-brand" },
  partial: { label: "Part paid", cls: "bg-warn/15 text-warn" },
  unpaid: { label: "Unpaid", cls: "bg-bad/10 text-bad" },
  none: { label: "No fee set", cls: "bg-page text-slate" },
};

/** The term fee exactly as the Super Admin set it, with the M-PESA prompt if unpaid. */
export function PaymentCard({ o, childName, preview, onPaid }: { o: Overview; childName: string; preview?: boolean; onPaid: () => void }) {
  const [open, setOpen] = useState(false);
  const p = o.payment;
  const s = PAY_STATUS[p.status];
  const number = p.method === "till" ? p.till : p.paybill;
  return (
    <section aria-label="Payment status" className="sheet">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate">{p.termLabel || "Fees"}</p>
          <p className={`display mt-1 text-[2.2rem] ${p.balance > 0 ? "extrude text-navy" : "extrude-good text-good"}`}>
            {p.balance > 0 ? money(p.balance, p.currency) : p.termFee ? money(p.termFee, p.currency) : money(0, p.currency)}
          </p>
          <p className="text-sm text-slate">
            {p.balance > 0 ? "Due" : "Paid"}{p.termFee ? ` · term fee ${money(p.termFee, p.currency)}` : ""}
            {p.deadline && p.balance > 0 ? ` · by ${shortDate(p.deadline)}` : ""}
          </p>
        </div>
        <span className={`chip mt-1 ${s.cls}`}>{s.label}</span>
      </div>
      {number && (
        <dl className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-page p-3 text-sm">
          <div><dt className="text-slate">M-PESA {p.method === "till" ? "Till" : "Paybill"}</dt><dd className="font-bold text-navy">{number}</dd></div>
          {p.method === "paybill" && <div><dt className="text-slate">Account</dt><dd className="font-bold text-navy">{p.accountReference}</dd></div>}
        </dl>
      )}
      {p.instructions && <p className="mt-3 text-[15px] text-ink">{p.instructions}</p>}
      {p.balance > 0 && p.mpesaEnabled && !preview && (
        <button className="btn mt-4 h-12 w-full bg-[#1f8a3b] text-base text-white hover:bg-[#1a7733]" onClick={() => setOpen(true)}>
          <Smartphone className="h-5 w-5" aria-hidden /> Pay {money(p.balance, p.currency)} with M-PESA
        </button>
      )}
      {p.balance > 0 && preview && <p className="mt-3 text-sm text-slate">The parent sees a "Pay with M-PESA" button here.</p>}
      <MpesaModal open={open} onClose={() => setOpen(false)} playerId={o.player.id} childName={childName}
        amount={p.balance} currency={p.currency} onPaid={onPaid} />
    </section>
  );
}
