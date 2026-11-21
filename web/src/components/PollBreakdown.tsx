import { Clock3 } from "lucide-react";
import { dateTime12 } from "../lib/format";

type Option = { id: string; label: string; tone: "good" | "ok" | "bad" };
type Vote = { userId: number; name: string; optionId: string; updatedAt: string };

const TONE = { good: "bg-good/12 text-good", ok: "bg-warn/15 text-warn", bad: "bg-bad/10 text-bad" };

/** "Coaches polled in": who answered, what and when; then assigned coaches still to answer. */
export function PollBreakdown({ options, poll, coaches }: { options: Option[]; poll: Vote[]; coaches: { id: number; name: string }[] }) {
  const answered = new Set(poll.map((p) => p.userId));
  const pending = coaches.filter((c) => !answered.has(c.id));
  const byTime = [...poll].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <section aria-label="Coaches polled in" className="sheet mt-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-bold text-navy">Coaches polled in</h3>
        <p className="text-sm text-slate">{poll.length} of {Math.max(coaches.length, poll.length)} answered</p>
      </div>
      {byTime.length > 0 ? (
        <ul className="mt-2 divide-y divide-line">
          {byTime.map((p) => {
            const o = options.find((x) => x.id === p.optionId);
            return (
              <li key={p.userId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
                <span className="text-[15px] font-semibold text-ink">{p.name}</span>
                <span className="flex items-center gap-2">
                  <span className={`chip ${TONE[o?.tone ?? "ok"]}`}>{o?.label ?? p.optionId}</span>
                  <time className="text-xs text-slate" dateTime={p.updatedAt}>{dateTime12(p.updatedAt)}</time>
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-[15px] text-slate">{coaches.length ? "No one has answered yet." : "No coaches are assigned to this school yet."}</p>
      )}
      {pending.length > 0 && (
        <div className="mt-3 rounded-xl bg-page p-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-slate"><Clock3 className="h-4 w-4" aria-hidden /> Still to answer ({pending.length})</p>
          <p className="mt-1 text-[15px] text-ink">{pending.map((c) => c.name).join(", ")}</p>
        </div>
      )}
    </section>
  );
}
