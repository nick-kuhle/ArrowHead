import {NextRequest} from "next/server";
import {botAuthHeaders, botFetch, botUpstreamUrl} from "@/lib/bot";

export const dynamic = "force-dynamic";

/**
 * Server-side bridge to the Rust bot(s), one per chain.
 *
 * This proxy is HONEST at every gate. The bot API is the single source of
 * truth for what this console shows: there is no demo generator and no
 * synthesised fallback. When the selected bot cannot be reached, every read
 * answers HTTP 503 with `ok:false` and `x-data-source: unreachable` — the UI
 * renders a "bot offline" state rather than fabricated head blocks, executor
 * addresses or risk envelopes that could be mistaken for live trading. The
 * only exception is `/api/stream`, whose SSE pipe is answered 503 for the
 * same reason (a wallet connected to a phantom executor is a worse failure
 * than an honest disconnect).
 */

function unreachable(path: string): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: `bot unreachable for /api/${path} — start the bot for this chain or fix CHAINS/BOT_API_URL`,
    }),
    {
      status: 503,
      headers: {"content-type": "application/json", "x-data-source": "unreachable"},
    },
  );
}

export async function GET(req: NextRequest, {params}: {params: Promise<{path: string[]}>}) {
  const {path} = await params;
  const route = path.join("/");
  const search = req.nextUrl.searchParams;
  // Multi-chain: the `?chain=` slug selects which bot instance to proxy to.
  // It is stripped before forwarding so the bot never sees it.
  const chainSlug = search.get("chain");
  const rest = new URLSearchParams(search);
  rest.delete("chain");
  const qs = rest.toString();

  if (route === "stream") {
    return streamResponse(qs, chainSlug);
  }

  const upstream = await botFetch(`/api/${route}${qs ? `?${qs}` : ""}`, 2500, chainSlug);
  if (upstream.ok) {
    return new Response(JSON.stringify(upstream.data), {
      headers: {"content-type": "application/json", "x-data-source": "bot"},
    });
  }
  return unreachable(route);
}

/**
 * SSE pipe for `/api/stream`. Re-streams the bot's live feed verbatim.
 *
 * When the bot is unreachable there is no feed to proxy, so — unlike the old
 * demo path, which synthesised fake mempool events so the tape "looked alive"
 * — the response is a plain 503. `lib/feed.ts` treats that as a disconnect
 * and the console shows the feed as down, which is the truth.
 */
async function streamResponse(qs: string, chainSlug?: string | null): Promise<Response> {
  const headers = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const upstream = await fetch(botUpstreamUrl(`/api/stream${qs ? `?${qs}` : ""}`, chainSlug), {
      signal: controller.signal,
      headers: {accept: "text/event-stream", ...botAuthHeaders(chainSlug)},
    });
    clearTimeout(timer);
    if (upstream.ok && upstream.body) {
      return new Response(upstream.body, {headers: {...headers, "x-data-source": "bot"}});
    }
  } catch {
    // fall through to the honest 503
  }

  return new Response(
    JSON.stringify({ok: false, error: "stream unreachable — bot offline for this chain"}),
    {status: 503, headers: {...headers, "x-data-source": "unreachable"}},
  );
}

export async function POST(req: NextRequest, {params}: {params: Promise<{path: string[]}>}) {
  if (!isAllowedControlOrigin(req)) {
    return new Response(
      JSON.stringify({ok: false, error: "cross-origin control request rejected"}),
      {
        status: 403,
        headers: {"content-type": "application/json"},
      },
    );
  }
  const {path} = await params;
  const route = path.join("/");
  // Multi-chain: mutations apply to the selected chain's bot instance only —
  // the switcher always sends the active slug, and a missing slug means the
  // first (default) chain, never a cross-chain write.
  const chainSlug = req.nextUrl.searchParams.get("chain");

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ok: false, error: "invalid JSON body"}), {
      status: 400,
      headers: {"content-type": "application/json"},
    });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const upstream = await fetch(botUpstreamUrl(`/api/${route}`, chainSlug), {
      method: "POST",
      signal: controller.signal,
      cache: "no-store",
      headers: {"content-type": "application/json", ...botAuthHeaders(chainSlug)},
      body: JSON.stringify(body),
    });
    clearTimeout(timer);
    const data = (await upstream
      .json()
      .catch(() => ({error: `bot returned HTTP ${upstream.status}`}))) as Record<string, unknown>;
    return new Response(JSON.stringify({...data, ok: upstream.ok, demo: false}), {
      status: upstream.status,
      headers: {"content-type": "application/json", "x-data-source": "bot"},
    });
  } catch {
    // No in-memory mutation fallback, ever: a control plane that answers 503
    // must not let the UI believe it changed the live bot.
    return unreachable(route);
  }
}

/**
 * Same-site guard for the mutating endpoints, compared on **authority**
 * (host[:port]), not on the full origin.
 *
 * The previous version rejected any request whose `Origin` header did not
 * exactly equal `req.nextUrl.origin` — including the scheme. That broke
 * legitimate control requests the moment the dashboard sat behind a
 * TLS-terminating reverse proxy or a hosted dev preview: the page is served
 * over `https://…` while the dev server speaks plain `http://…`, so the two
 * origins can never be string-equal even though page and route live on the
 * same host and port.
 *
 * What must still hold: the request's site of origin is the dashboard itself.
 * A browser POSTing from another site always sends an `Origin` whose
 * authority is *that site*, so comparing the authority against the request
 * host (or the first `X-Forwarded-Host` hop a proxy sets) rejects cross-site
 * postings without pinning the scheme. `sec-fetch-site: cross-site` remains
 * an independent rejection where the browser supplies it.
 */
function isAllowedControlOrigin(req: NextRequest): boolean {
  if (req.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let authority: string;
  try {
    authority = new URL(origin).host;
  } catch {
    return false;
  }
  const candidates = [
    req.nextUrl.host,
    req.headers.get("x-forwarded-host")?.split(",")[0].trim(),
    req.headers.get("host"),
  ].filter((h): h is string => Boolean(h));
  return candidates.includes(authority);
}