import { randomBytes } from "node:crypto";
import { getSetting } from "@/core/app-settings";
import { buildAuthUrl, GOOGLE_KEYS } from "@/modules/calendar/google";

export async function GET(req: Request) {
  const clientId = await getSetting(GOOGLE_KEYS.clientId);
  if (!clientId) {
    return Response.json(
      { error: "Set google_client_id in Settings first" },
      { status: 400 },
    );
  }
  const origin = new URL(req.url).origin;
  // CSRF guard: the callback only accepts a code accompanied by this state.
  const state = randomBytes(16).toString("hex");
  return new Response(null, {
    status: 302,
    headers: {
      Location: buildAuthUrl(clientId, origin, state),
      "Set-Cookie": `google_oauth_state=${state}; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
}
