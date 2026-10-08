import { createClient } from "@supabase/supabase-js";
import { env } from "./env";

/**
 * supabase-js constructs a RealtimeClient eagerly, and on Node < 22 that throws
 * because there is no global WebSocket. This server only uses PostgREST and
 * Storage, so we hand realtime a stub rather than pulling in `ws` or forcing a
 * Node upgrade. It throws if anything ever genuinely tries to open a socket,
 * which is preferable to silently pretending realtime works.
 */
class UnsupportedRealtimeTransport {
  constructor() {
    throw new Error(
      "Realtime is not supported by this server. Use PostgREST queries instead.",
    );
  }
}

/**
 * Service-role client. Bypasses RLS, so it must only ever be reachable from
 * this server process — never proxied straight through to a caller.
 */
export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: UnsupportedRealtimeTransport as never },
});

export const RESUME_BUCKET = "resumes";

/**
 * Narrow Supabase's `{ data, error }` into a throwing call site.
 *
 * `NonNullable` matters here: Supabase types `data` as `T | null`, so without
 * it TypeScript infers `T` as the nullable union and every caller has to
 * re-check for null after we already threw on it.
 */
export function unwrap<T>(
  result: { data: T | null; error: { message: string } | null },
  context: string,
): NonNullable<T> {
  if (result.error) {
    throw new Error(`${context}: ${result.error.message}`);
  }
  if (result.data === null || result.data === undefined) {
    throw new Error(`${context}: no data returned`);
  }
  return result.data as NonNullable<T>;
}
