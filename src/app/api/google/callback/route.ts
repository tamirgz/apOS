import { exchangeCode } from "@/modules/calendar/google";

/** Where the user lands after the OAuth dance — the Connections page reads the
 *  `google` query param and shows the outcome. */
const RETURN_PATH = "/m/settings/connections";

function redirectWithResult(origin: string, result: string) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${origin}${RETURN_PATH}?google=${encodeURIComponent(result)}`,
      // one-shot: clear the state cookie either way
      "Set-Cookie":
        "google_oauth_state=; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=0",
    },
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (err || !code) {
    return redirectWithResult(url.origin, err ?? "no-code");
  }
  // CSRF guard: the state must match the cookie set when the flow started.
  const state = url.searchParams.get("state");
  const cookieState = req.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)google_oauth_state=([^;]+)/)?.[1];
  if (!state || !cookieState || state !== cookieState) {
    return redirectWithResult(url.origin, "state-mismatch");
  }
  try {
    await exchangeCode(code, url.origin);
    return redirectWithResult(url.origin, "connected");
  } catch (e) {
    return redirectWithResult(url.origin, String(e).slice(0, 120));
  }
}
