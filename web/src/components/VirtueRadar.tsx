import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip } from "recharts";
import { VIRTUE_LABELS } from "../lib/format";

/** Character & virtue growth: season average per virtue (1–10). */
export function VirtueRadar({ data, compare }: { data: { virtue: string; average: number }[]; compare?: { virtue: string; average: number }[] }) {
  const rows = data.map((d) => ({
    virtue: VIRTUE_LABELS[d.virtue] ?? d.virtue,
    score: d.average,
    earlier: compare?.find((c) => c.virtue === d.virtue)?.average ?? undefined,
  }));
  const label = rows.map((r) => `${r.virtue} ${r.score || "not yet scored"}`).join(", ");
  return (
    <div className="h-72 w-full" role="img" aria-label={`Virtue scores out of 10: ${label}`}>
      <ResponsiveContainer>
        <RadarChart data={rows} outerRadius="72%">
          <PolarGrid stroke="#d9e0ec" />
          <PolarAngleAxis dataKey="virtue" tick={{ fill: "#0f2147", fontSize: 12, fontWeight: 600 }} />
          <PolarRadiusAxis domain={[0, 10]} tickCount={6} tick={{ fill: "#5b6690", fontSize: 10 }} axisLine={false} />
          {compare && <Radar name="Start of season" dataKey="earlier" stroke="#9aa6c8" fill="#9aa6c8" fillOpacity={0.12} strokeDasharray="4 3" />}
          <Radar name="This season" dataKey="score" stroke="#2f5bd3" strokeWidth={2} fill="#2f5bd3" fillOpacity={0.28} dot={{ r: 3, fill: "#2f5bd3" }} />
          <Tooltip formatter={(v) => [`${v} / 10`, "Average"]} contentStyle={{ borderRadius: 12, border: "1px solid #d9e0ec" }} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}
