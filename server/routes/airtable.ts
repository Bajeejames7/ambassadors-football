import { Router } from "express";
import { z } from "zod";
import { me, requirePermission, requireStaff } from "../auth.js";
import { one } from "../db.js";
import { getRecord, searchPlayers } from "../lib/airtable.js";
import { registerPlayer } from "../lib/field.js";
import { HttpError } from "../auth.js";

export const airtableRoutes = Router();

/** Instant search of the intramural's Airtable roster. */
airtableRoutes.get("/intramurals/:id/airtable/search", async (req, res) => {
  const user = me(req);
  requireStaff(user);
  const id = Number(req.params.id);
  await requirePermission(user, "roster.view", id);
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) {
    res.json([]);
    return;
  }
  const results = await searchPlayers(id, q.slice(0, 60));
  // Mark which ones are already in the app.
  const out = [];
  for (const r of results) {
    const existing = await one(`SELECT id FROM players WHERE intramural_id = $1 AND airtable_record_id = $2`, [id, r.recordId]);
    out.push({ ...r, playerId: existing?.id ?? null });
  }
  res.json(out);
});

/** Bring an Airtable registration into the app's roster. */
airtableRoutes.post("/intramurals/:id/airtable/import", async (req, res) => {
  const user = me(req);
  const id = Number(req.params.id);
  await requirePermission(user, "players.register", id);
  const { recordId } = z.object({ recordId: z.string() }).parse(req.body);
  const existing = await one(`SELECT id FROM players WHERE intramural_id = $1 AND airtable_record_id = $2`, [id, recordId]);
  if (existing) {
    res.json({ id: existing.id, duplicate: true });
    return;
  }
  const r = await getRecord(id, recordId);
  if (!r.firstName) throw new HttpError(400, "That Airtable record has no name");
  const result = await registerPlayer(user, {
    intramuralId: id, firstName: r.firstName, lastName: r.lastName, dateOfBirth: r.dateOfBirth, category: r.category, team: "",
    guardianName: r.guardianName, guardianEmail: r.guardianEmail, guardianPhone: r.guardianPhone, medicalNotes: "", walkIn: false,
  });
  await one(`UPDATE players SET airtable_record_id = $2, source = 'airtable' WHERE id = $1 RETURNING id`, [result.id, recordId]);
  res.status(201).json(result);
});
