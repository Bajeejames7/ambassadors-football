import { Router } from "express";
import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError, me, requirePermission } from "../auth.js";
import { one, query } from "../db.js";
import { WEEKDAYS, formatTime12, weekdayOf, addDays } from "../util.js";

/**
 * One-click matchday report: game results, player and coach attendance,
 * equipment status, standout virtue milestones and welfare, as a PDF for
 * executive review. Mentorship notes stay confidential: only counts and
 * scripture milestones are included.
 */
export const reportRoutes = Router();

const NAVY = "#16224F";
const BRAND = "#2F5BD3";
const MUTED = "#5B6690";
const LINE = "#DCE3F2";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOGO = [path.resolve(here, "../../web/public/logo.jpg"), path.resolve(here, "../../../web/public/logo.jpg"), path.resolve(here, "../web/logo.jpg"), path.resolve(here, "../../web/logo.jpg"), path.resolve(here, "web/logo.jpg")].find(existsSync);

export async function gatherReport(sessionId: number) {
  const s = await one(
    `SELECT s.id, s.date, s.kind, s.title, s.opponent, to_char(s.start_time,'HH24:MI') AS "startTime", to_char(s.end_time,'HH24:MI') AS "endTime",
            s.location, s.roles, s.cancelled, i.id AS "intramuralId", i.name AS "intramuralName", i.teams, i.availability_options AS options,
            c.name AS country
       FROM sessions s JOIN intramurals i ON i.id = s.intramural_id JOIN countries c ON c.id = i.country_id WHERE s.id = $1`,
    [sessionId],
  );
  if (!s) throw new HttpError(404, "That session does not exist");
  const weekStart = addDays(s.date, -((weekdayOf(s.date) + 6) % 7));
  const [attendance, byCategory, poll, matches, teamPoints, equipment, injuries, awards, virtueStars, mentorship] = await Promise.all([
    one(
      `SELECT count(*) FILTER (WHERE a.status = 'present') AS present, count(*) FILTER (WHERE a.status = 'late') AS late,
              count(*) FILTER (WHERE a.status = 'absent') AS absent, count(*) FILTER (WHERE a.status = 'excused') AS excused,
              (SELECT count(*) FROM players WHERE intramural_id = $2 AND active) AS roster,
              count(*) FILTER (WHERE p.source = 'walk_in' AND p.created_at::date = $3) AS "walkIns"
         FROM attendance a JOIN players p ON p.id = a.player_id WHERE a.session_id = $1`,
      [sessionId, s.intramuralId, s.date],
    ),
    query(
      `SELECT coalesce(nullif(p.category,''),'Unassigned') AS category, count(*) AS roster,
              count(a.*) FILTER (WHERE a.status IN ('present','late')) AS attended
         FROM players p LEFT JOIN attendance a ON a.player_id = p.id AND a.session_id = $1
        WHERE p.intramural_id = $2 AND p.active GROUP BY 1 ORDER BY 1`,
      [sessionId, s.intramuralId],
    ),
    query(`SELECT u.name, v.option_id AS "optionId" FROM availability v JOIN users u ON u.id = v.user_id WHERE v.session_id = $1 ORDER BY u.name`, [sessionId]),
    query(`SELECT team, opponent, points, opponent_points AS "opponentPoints", category, note FROM tally_events WHERE session_id = $1 AND kind = 'match' ORDER BY id`, [sessionId]),
    query(`SELECT team, kind, sum(points) AS points FROM tally_events WHERE session_id = $1 AND kind IN ('virtue_points','sportsmanship') GROUP BY team, kind ORDER BY 3 DESC`, [sessionId]),
    query(`SELECT phase, items, notes FROM equipment_checks WHERE session_id = $1`, [sessionId]),
    query(
      `SELECT p.first_name || ' ' || p.last_name AS name, j.severity, j.body_part AS "bodyPart", j.description, j.action_taken AS "actionTaken",
              j.parent_acknowledged_at IS NOT NULL AS acknowledged
         FROM injuries j JOIN players p ON p.id = j.player_id WHERE j.session_id = $1 OR (p.intramural_id = $2 AND j.created_at::date = $3)`,
      [sessionId, s.intramuralId, s.date],
    ),
    query(
      `SELECT p.first_name || ' ' || p.last_name AS name, a.award, a.virtue, a.reason
         FROM character_awards a JOIN players p ON p.id = a.player_id WHERE a.intramural_id = $1 AND (a.session_id = $2 OR a.week_of = $3)`,
      [s.intramuralId, sessionId, weekStart],
    ),
    query(
      `SELECT p.first_name || ' ' || p.last_name AS name, v.virtue, max(v.score) AS score
         FROM virtue_scores v JOIN players p ON p.id = v.player_id WHERE v.session_id = $1 AND v.score >= 8
        GROUP BY 1, 2 ORDER BY 3 DESC, 1 LIMIT 12`,
      [sessionId],
    ),
    one(
      `SELECT count(*) AS logs, count(DISTINCT coach_id) AS coaches,
              coalesce(array_agg(DISTINCT scripture_milestone) FILTER (WHERE scripture_milestone <> ''), '{}') AS milestones
         FROM mentorship_logs WHERE session_id = $1`,
      [sessionId],
    ),
  ]);
  const roleNames = new Map(
    (await query(`SELECT id, name FROM users WHERE id = ANY($1)`, [(s.roles as { userId: number | null }[]).map((r) => r.userId).filter(Boolean)])).map((u) => [u.id, u.name]),
  );
  return { s, attendance, byCategory, poll, matches, teamPoints, equipment, injuries, awards, virtueStars, mentorship, roleNames };
}

function titleCase(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

export function renderReport(data: Awaited<ReturnType<typeof gatherReport>>, generatedBy: string): PDFKit.PDFDocument {
  const { s, attendance, byCategory, poll, matches, teamPoints, equipment, injuries, awards, virtueStars, mentorship, roleNames } = data;
  const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true, info: { Title: `Matchday Report — ${s.intramuralName} — ${s.date}`, Author: "Ambassadors Football" } });
  const width = doc.page.width - 96;

  // Header band
  doc.rect(0, 0, doc.page.width, 110).fill(NAVY);
  if (LOGO) doc.image(LOGO, 48, 24, { width: 60, height: 60 });
  doc.fill("#FFFFFF").font("Helvetica-Bold").fontSize(18).text("AMBASSADORS FOOTBALL", 120, 30);
  doc.font("Helvetica").fontSize(9).fillColor("#C9D3F2").text("FOOTBALL. FAITH. FUTURE.", 120, 52, { characterSpacing: 2 });
  doc.fillColor("#FFFFFF").fontSize(11).text("Matchday Report", 120, 70);
  doc.y = 130;

  const kindLabel = s.kind === "match" ? `Match${s.opponent ? ` vs ${s.opponent}` : ""}` : s.kind === "tournament" ? s.title || "Tournament" : `${WEEKDAYS[weekdayOf(s.date)]} Session`;
  doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(16).text(`${s.intramuralName} — ${kindLabel}`, 48);
  doc.font("Helvetica").fontSize(10).fillColor(MUTED)
    .text(`${WEEKDAYS[weekdayOf(s.date)]}, ${s.date}  ·  ${formatTime12(s.startTime)} – ${formatTime12(s.endTime)}${s.location ? `  ·  ${s.location}` : ""}  ·  ${s.country}`);
  if (s.cancelled) doc.fillColor("#D8412F").font("Helvetica-Bold").text("This session was cancelled.");
  doc.moveDown(1);

  // Key figures
  const attended = Number(attendance.present) + Number(attendance.late);
  const recorded = attended + Number(attendance.absent) + Number(attendance.excused);
  const coming = poll.filter((p) => (s.options as { id: string; tone: string }[]).find((o) => o.id === p.optionId)?.tone !== "bad").length;
  const tiles = [
    ["Players attended", `${attended} / ${attendance.roster}`],
    ["Attendance rate", recorded ? `${Math.round((100 * attended) / recorded)}%` : "—"],
    ["Coaches available", `${coming} / ${poll.length}`],
    ["Injuries / knocks", String(injuries.length)],
  ];
  const tileW = (width - 30) / 4;
  const top = doc.y;
  tiles.forEach(([label, value], k) => {
    const x = 48 + k * (tileW + 10);
    doc.roundedRect(x, top, tileW, 54, 8).fill("#EEF2FA");
    doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(16).text(value, x + 10, top + 10, { width: tileW - 20 });
    doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(label.toUpperCase(), x + 10, top + 34, { width: tileW - 20 });
  });
  doc.y = top + 70;

  const section = (title: string) => {
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.moveDown(0.6);
    doc.fillColor(BRAND).font("Helvetica-Bold").fontSize(10).text(title.toUpperCase(), 48, doc.y, { characterSpacing: 1.5 });
    doc.moveTo(48, doc.y + 3).lineTo(48 + width, doc.y + 3).strokeColor(LINE).stroke();
    doc.moveDown(0.6);
    doc.fillColor(NAVY).font("Helvetica").fontSize(10);
  };
  const table = (cols: { label: string; w: number }[], rows: string[][]) => {
    let y = doc.y;
    const draw = (cells: string[], bold: boolean) => {
      let x = 48;
      const h = Math.max(...cells.map((c, k) => doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).heightOfString(c || "—", { width: cols[k].w * width - 6 }))) + 6;
      if (y + h > doc.page.height - 60) { doc.addPage(); y = 48; }
      cells.forEach((c, k) => {
        doc.fillColor(bold ? MUTED : NAVY).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).text(c || "—", x + 3, y + 3, { width: cols[k].w * width - 6 });
        x += cols[k].w * width;
      });
      y += h;
      doc.moveTo(48, y).lineTo(48 + width, y).strokeColor(LINE).lineWidth(0.5).stroke();
    };
    draw(cols.map((c) => c.label), true);
    rows.forEach((r) => draw(r, false));
    doc.y = y + 4;
    doc.x = 48;
  };
  const none = (text: string) => doc.fillColor(MUTED).font("Helvetica-Oblique").fontSize(9).text(text, 48).font("Helvetica");

  section("Game statistics");
  if (matches.length) {
    table([{ label: "Home", w: 0.3 }, { label: "Score", w: 0.15 }, { label: "Away", w: 0.3 }, { label: "Category / note", w: 0.25 }],
      matches.map((m) => [m.team, `${m.points} – ${m.opponentPoints}`, m.opponent, [m.category, m.note].filter(Boolean).join(" · ")]));
  } else none("No match scores were recorded.");
  if (teamPoints.length) {
    doc.moveDown(0.4);
    const teams = new Map((s.teams as { id: string; name: string }[]).map((t) => [t.id, t.name]));
    table([{ label: "Team", w: 0.5 }, { label: "Points type", w: 0.3 }, { label: "Points", w: 0.2 }],
      teamPoints.map((t) => [teams.get(t.team) ?? t.team, t.kind === "sportsmanship" ? "Sportsmanship" : "Virtue points", String(t.points)]));
  }

  section("Player attendance");
  doc.text(`Present ${attendance.present} · Late ${attendance.late} · Absent ${attendance.absent} · Excused ${attendance.excused} · Walk-ins registered ${attendance.walkIns}`);
  doc.moveDown(0.4);
  table([{ label: "Category", w: 0.4 }, { label: "Attended", w: 0.2 }, { label: "Roster", w: 0.2 }, { label: "Rate", w: 0.2 }],
    byCategory.map((c) => [c.category, String(c.attended), String(c.roster), c.roster ? `${Math.round((100 * c.attended) / c.roster)}%` : "—"]));

  section("Coaches");
  const options = new Map((s.options as { id: string; label: string }[]).map((o) => [o.id, o.label]));
  if (poll.length) table([{ label: "Coach", w: 0.4 }, { label: "Availability", w: 0.6 }], poll.map((p) => [p.name, options.get(p.optionId) ?? p.optionId]));
  else none("No coaches answered the availability poll.");
  const roles = (s.roles as { role: string; userId: number | null }[]).filter((r) => r.userId);
  if (roles.length) {
    doc.moveDown(0.4);
    table([{ label: "Session role", w: 0.5 }, { label: "Coach", w: 0.5 }], roles.map((r) => [r.role, roleNames.get(r.userId!) ?? ""]));
  }

  section("Equipment status");
  if (equipment.length) {
    const before = equipment.find((e) => e.phase === "before");
    const after = equipment.find((e) => e.phase === "after");
    type Item = { itemId: number; name: string; expected: number; counted: number; condition: string };
    const all = new Map<number, { name: string; expected: number; before?: Item; after?: Item }>();
    for (const [phase, check] of [["before", before], ["after", after]] as const) {
      for (const it of (check?.items ?? []) as Item[]) {
        const row = all.get(it.itemId) ?? { name: it.name, expected: it.expected };
        row[phase] = it;
        all.set(it.itemId, row);
      }
    }
    table([{ label: "Item", w: 0.3 }, { label: "Expected", w: 0.14 }, { label: "Before", w: 0.14 }, { label: "After", w: 0.14 }, { label: "Status", w: 0.28 }],
      [...all.values()].map((r) => {
        const lost = r.before && r.after ? r.before.counted - r.after.counted : 0;
        const status = r.after?.condition === "damaged" ? "Damaged" : lost > 0 ? `${lost} missing after session` : (r.before?.counted ?? r.expected) < r.expected ? "Short before session" : "OK";
        return [r.name, String(r.expected), r.before ? String(r.before.counted) : "—", r.after ? String(r.after.counted) : "—", status];
      }));
    const notes = equipment.map((e) => e.notes).filter(Boolean).join(" ");
    if (notes) doc.fillColor(MUTED).fontSize(9).text(`Notes: ${notes}`, 48);
  } else none("The equipment checklist was not completed.");

  section("Standout virtue milestones");
  if (awards.length || virtueStars.length) {
    for (const a of awards) doc.font("Helvetica-Bold").fillColor(NAVY).text(`• ${a.name} — ${a.award}`, 48).font("Helvetica").fillColor(MUTED).text(a.reason || titleCase(a.virtue), 60);
    if (virtueStars.length) {
      doc.moveDown(0.3);
      table([{ label: "Player", w: 0.5 }, { label: "Virtue", w: 0.3 }, { label: "Score", w: 0.2 }], virtueStars.map((v) => [v.name, titleCase(v.virtue), `${v.score}/10`]));
    }
  } else none("No awards or high virtue scores were recorded.");
  doc.moveDown(0.3);
  doc.fillColor(NAVY).font("Helvetica").fontSize(9).text(
    `Mentorship: ${mentorship.logs} reflection log${mentorship.logs === 1 ? "" : "s"} by ${mentorship.coaches} coach${mentorship.coaches === 1 ? "" : "es"} (details are confidential).`, 48);
  if ((mentorship.milestones as string[]).length) doc.text(`Scripture milestones: ${(mentorship.milestones as string[]).join("; ")}`, 48);

  section("Welfare & injuries");
  if (injuries.length) {
    table([{ label: "Player", w: 0.22 }, { label: "Severity", w: 0.13 }, { label: "What happened", w: 0.35 }, { label: "Action", w: 0.2 }, { label: "Parent seen", w: 0.1 }],
      injuries.map((j) => [j.name, titleCase(j.severity), [j.bodyPart, j.description].filter(Boolean).join(": "), j.actionTaken, j.acknowledged ? "Yes" : "No"]));
  } else none("No injuries or knocks were reported.");

  const stamp = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", hour12: true, timeZone: "Africa/Nairobi" }).format(new Date());
  const range = doc.bufferedPageRange();
  for (let k = range.start; k < range.start + range.count; k++) {
    doc.switchToPage(k);
    doc.page.margins.bottom = 0; // the footer sits in the margin without starting a new page
    doc.fillColor(MUTED).fontSize(8).text(`Generated ${stamp} by ${generatedBy} · Page ${k + 1} of ${range.count} · Confidential: contains information about children`,
      48, doc.page.height - 36, { width, align: "center", lineBreak: false });
  }
  return doc;
}

reportRoutes.get("/sessions/:id/report.pdf", async (req, res) => {
  const user = me(req);
  const sessionId = Number(req.params.id);
  const s = await one(`SELECT intramural_id AS "intramuralId", date FROM sessions WHERE id = $1`, [sessionId]);
  if (!s) throw new HttpError(404, "That session does not exist");
  await requirePermission(user, "reports.generate", s.intramuralId);
  const data = await gatherReport(sessionId);
  const doc = renderReport(data, user.name);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="matchday-report-${data.s.intramuralName.replace(/\W+/g, "-").toLowerCase()}-${s.date}.pdf"`);
  doc.pipe(res);
  doc.end();
});
