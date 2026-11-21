import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { cached } from "../lib/offline";
import { time12, WEEKDAYS } from "../lib/format";
import { Crest, Empty, ErrorNote, PageTitle, Spinner } from "../components/ui";
import { AirtableForm } from "../components/AirtableForm";

interface Program {
  id: number;
  name: string;
  shortCode: string;
  color: string;
  logo: string;
  kind: string;
  programMode: "school" | "club";
  sessionWeekday: number;
  sessionStart: string;
  sessionEnd: string;
  location: string;
  formUrl: string | null;
  mine: boolean;
}

/**
 * Register & Pay: the parent picks a school or club and fills in its own
 * Airtable registration form, which takes the M-PESA payment too.
 */
export function RegisterPage() {
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ["programs"], queryFn: () => cached<Program[]>("/parent/programs") });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorNote error={q.error} onRetry={() => q.refetch()} />;
  const programs = q.data!;
  const chosen = programs.find((p) => p.id === Number(params.get("school"))) ?? programs.find((p) => p.mine) ?? programs[0];
  return (
    <>
      <PageTitle banner title="Register & pay" sub="Choose the school or club, then fill in its form. M-PESA payment is part of the form." />
      <div className="-mx-4 mb-4 flex gap-3 overflow-x-auto px-4 pb-4 pt-1" role="tablist" aria-label="Schools and clubs">
        {programs.map((p) => (
          <button key={p.id} role="tab" aria-selected={p.id === chosen?.id}
            ref={p.id === chosen?.id ? (el) => el?.scrollIntoView({ block: "nearest", inline: "center" }) : undefined}
            onClick={() => setParams({ school: String(p.id) }, { replace: true })}
            className="token flex shrink-0 items-center gap-2 rounded-2xl py-2 pl-2 pr-4 text-left text-navy">
            <Crest i={p} size={34} />
            <span>
              <span className="block text-[15px] font-bold leading-tight">{p.name}</span>
              <span className="block text-xs opacity-75">{p.mine ? "Your child's" : p.programMode === "school" ? "School" : "Club"}</span>
            </span>
          </button>
        ))}
      </div>
      {chosen ? (
        <>
          <p className="mb-3 text-[15px] text-slate">
            {chosen.name}: {WEEKDAYS[chosen.sessionWeekday]}s, {time12(chosen.sessionStart)} – {time12(chosen.sessionEnd)}{chosen.location ? ` at ${chosen.location}` : ""}.
          </p>
          {chosen.formUrl ? (
            <AirtableForm url={chosen.formUrl} schoolName={chosen.name} />
          ) : (
            <Empty>{chosen.name} hasn't added its registration form yet. Ask the coordinator.</Empty>
          )}
        </>
      ) : (
        <Empty>No schools or clubs are open for registration yet.</Empty>
      )}
    </>
  );
}
