import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { MAX_REQUEST_BODY_BYTES } from "@crm/shared/constants";
import { env } from "./env";
import { HttpError, api } from "./routes";

const app = new Hono();

const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return undefined;
      for (const rule of allowed) {
        if (rule === origin) return origin;
        // Support a `chrome-extension://*` wildcard for local development,
        // where the extension id changes on every unpacked reload.
        if (rule.endsWith("*") && origin.startsWith(rule.slice(0, -1))) {
          return origin;
        }
      }
      return undefined;
    },
    allowHeaders: ["content-type", "x-crm-token"],
    // DELETE belongs here because `/api/messages/:id` is a route the side panel
    // actually calls — discarding a draft. Leaving it out did not disable the
    // feature visibly; it failed the preflight, so Discard looked like a network
    // error and the draft stayed in "Needs your approval".
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);

/**
 * A ceiling on the body before anything reads it.
 *
 * The zod schemas bound each individual field, but they only run *after* the
 * whole body has been received and `JSON.parse`d into the heap. A 2GB POST is
 * rejected by the schema having already cost 2GB of memory, on a process that
 * is also serving the side panel. This refuses it at the socket.
 */
app.use("*", bodyLimit({ maxSize: MAX_REQUEST_BODY_BYTES }));

app.get("/health", (c) => c.json({ ok: true }));

/**
 * This process holds the OpenAI key and the Supabase service-role key, so every
 * route behind here requires the shared secret. Compared with a constant-time
 * check the risk from early-exit timing on a 32-byte random token is negligible,
 * but it costs nothing to avoid.
 */
app.use("/api/*", async (c, next) => {
  const token = c.req.header("x-crm-token");
  if (!token || !timingSafeEqual(token, env.CRM_AUTH_TOKEN)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

app.route("/api", api);

/**
 * `HttpError` is the deliberate half: something the caller did, phrased for the
 * caller, and safe to show. Anything else reaching here is a bug, and its
 * message is written for whoever is reading the server log — Postgres includes
 * table and column names, the OpenAI client includes request metadata, and a
 * driver-level failure can include a connection string. None of that belongs in
 * a panel the user reads, and it is the kind of thing that stops being merely
 * untidy the moment this runs anywhere but localhost.
 *
 * The reference is the compromise: the panel shows a short id, the terminal
 * logs the same id next to the real stack, so a user reporting "it failed" can
 * point at the exact line without the server having to say anything sensitive.
 */
app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message, detail: err.detail }, err.status as 400);
  }

  const reference = crypto.randomUUID().slice(0, 8);
  console.error(`[crm] unhandled error (ref ${reference}):`, err);
  return c.json(
    {
      error: "Something went wrong on the server.",
      detail: `Check the server terminal for reference ${reference}.`,
    },
    500,
  );
});

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Bound to the loopback interface explicitly.
 *
 * `serve` defaults to `0.0.0.0`, so this process — which holds the OpenAI key
 * and a Supabase service-role key that bypasses RLS — was reachable from every
 * other device on the network, including a café or hotel LAN. Nothing said so:
 * the log line below printed "localhost" either way, and `docs/SECURITY.md`
 * asserted a loopback bind that was never actually configured.
 *
 * The shared-secret check on `/api/*` was the only thing standing in front of
 * it. That is one mistyped `.env` away from being the whole security model.
 *
 * `env.HOST` defaults to `127.0.0.1` and is overridden only in the container,
 * where loopback means the container's own and nothing can reach it. The log
 * line prints what was actually bound, because the previous one printed
 * "localhost" regardless and that is how the wrong bind went unnoticed.
 */
serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  console.log(`[crm] proxy listening on http://${env.HOST}:${info.port}`);
});
