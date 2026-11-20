import { Router } from "express";
import { z } from "zod";
import { HttpError, me } from "../auth.js";
import {
  addMentorshipLog, addTally, answerAvailability, attendanceInput, availabilityInput, equipmentInput, injuryInput,
  mentorshipInput, playerInput, recordAttendance, registerPlayer, reportInjury, saveEquipmentCheck, tallyInput,
} from "../lib/field.js";

/**
 * The phone's offline queue, sent in one request when the connection is back
 * (from the app, or from the service worker's Background Sync). Each operation
 * is applied on its own: one rejected op never blocks the rest. The phone
 * removes ops answered ok, or rejected for good (4xx); it keeps the rest to retry.
 */
export const syncRoutes = Router();

const handlers = {
  attendance: { schema: attendanceInput, run: recordAttendance },
  walk_in: { schema: playerInput, run: registerPlayer },
  tally: { schema: tallyInput, run: addTally },
  equipment: { schema: equipmentInput, run: saveEquipmentCheck },
  mentorship: { schema: mentorshipInput, run: addMentorshipLog },
  injury: { schema: injuryInput, run: reportInjury },
  availability: { schema: availabilityInput, run: answerAvailability },
} as const;

const syncInput = z.object({
  ops: z
    .array(z.object({ id: z.string().min(8).max(64), type: z.enum(Object.keys(handlers) as [keyof typeof handlers]), payload: z.unknown() }))
    .max(200),
});

syncRoutes.post("/sync", async (req, res) => {
  const user = me(req);
  const { ops } = syncInput.parse(req.body);
  const results = [];
  for (const op of ops) {
    const h = handlers[op.type];
    try {
      // The op id doubles as the clientId, so a re-sent op is applied once.
      const payload = { ...(op.payload as object), ...(["walk_in", "tally", "mentorship", "injury", "equipment"].includes(op.type) ? { clientId: op.id } : {}) };
      const result = await (h.run as (m: typeof user, p: unknown) => Promise<unknown>)(user, h.schema.parse(payload));
      results.push({ id: op.id, ok: true, result });
    } catch (err) {
      if (err instanceof HttpError) results.push({ id: op.id, ok: false, status: err.status, error: err.message, body: err.body });
      else if (err instanceof z.ZodError) results.push({ id: op.id, ok: false, status: 400, error: err.issues[0]?.message ?? "Invalid" });
      else {
        console.error("[sync]", err);
        results.push({ id: op.id, ok: false, status: 500, error: "Server error; will retry" });
      }
    }
  }
  res.json({ results });
});
