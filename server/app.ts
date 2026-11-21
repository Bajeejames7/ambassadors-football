import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import { HttpError, requireUser } from "./auth.js";
import { accountRoutes, publicAuthRoutes } from "./routes/auth.js";
import { creatorRoutes } from "./routes/creator.js";
import { peopleRoutes } from "./routes/people.js";
import { intramuralRoutes } from "./routes/intramurals.js";
import { sessionRoutes } from "./routes/sessions.js";
import { playerRoutes } from "./routes/players.js";
import { coachingRoutes } from "./routes/coaching.js";
import { mpesaCallbackRoutes, paymentRoutes } from "./routes/payments.js";
import { airtableRoutes } from "./routes/airtable.js";
import { syncRoutes } from "./routes/sync.js";
import { reportRoutes } from "./routes/reports.js";
import { controlRoutes, publicControlRoutes } from "./routes/control.js";

export function createApp(webDir?: string) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  // Google Play (Trusted Web Activity): proves the Android app and this site belong together.
  // Set ANDROID_PACKAGE and ANDROID_SHA256 (the Play App Signing certificate fingerprint).
  app.get("/.well-known/assetlinks.json", (_req, res) => {
    const pkg = process.env.ANDROID_PACKAGE;
    const fingerprints = (process.env.ANDROID_SHA256 ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!pkg || fingerprints.length === 0) {
      res.status(404).json({ error: "Not configured" });
      return;
    }
    res.json([{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: fingerprints } }]);
  });

  const api = express.Router();
  api.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  // No sign-in needed: onboarding, sign-in, and Safaricom's callback.
  api.use(publicAuthRoutes, mpesaCallbackRoutes, publicControlRoutes);
  // Everything else needs a signed-in person.
  api.use(accountRoutes);
  api.use(requireUser);
  api.use(controlRoutes, creatorRoutes, peopleRoutes, intramuralRoutes, sessionRoutes, playerRoutes, coachingRoutes, paymentRoutes, airtableRoutes, syncRoutes, reportRoutes);
  api.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  }, api);

  if (webDir && existsSync(webDir)) {
    const noCache = (res: Response) => res.setHeader("Cache-Control", "no-cache");
    app.use(
      express.static(webDir, {
        index: false,
        maxAge: "7d",
        setHeaders: (res, file) => {
          if (/\.(html|webmanifest|json)$/.test(file) || file.endsWith("sw.js")) noCache(res);
        },
      }),
    );
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      noCache(res);
      res.sendFile(path.join(webDir, "index.html"));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.issues[0]?.message ?? "Check what you entered" });
    } else if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, ...err.body });
    } else if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "Could not read the request" });
    } else {
      console.error(err);
      res.status(500).json({ error: "Something went wrong on the server. Try again." });
    }
  });
  return app;
}
