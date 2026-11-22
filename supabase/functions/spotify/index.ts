import { createClient } from "npm:@supabase/supabase-js@2";

const authOk = (k: string | null) => {
  const raw = Deno.env.get("APP_ACCESS_KEY") ?? "";
  const keys = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return !!k && keys.includes(k);
};

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const H = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const REDIRECT_URI = `${Deno.env.get("SUPABASE_URL")}/functions/v1/spotify`;
const APP_URL = Deno.env.get("APP_URL") ?? "https://8jdy5vhpx47w.ample.run/";
const STATE_TTL = 10 * 60 * 1000;
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });

function creds() {
  const id = Deno.env.get("SPOTIFY_CLIENT_ID") ?? Deno.env.get("CLIENT_ID");
  const sec = Deno.env.get("SPOTIFY_CLIENT_SECRET") ?? Deno.env.get("CLIENT_SECRET");
  if (!id || !sec) throw new Error("Missing Spotify client secrets");
  return { id, sec, basic: "Basic " + btoa(`${id}:${sec}`) };
}

async function getToken(): Promise<{ access_token: string; refresh_token: string; expires_at: number } | null> {
  const { data } = await sb.from("source_results").select("data").eq("query_norm", "spotify_oauth").eq("source", "token").maybeSingle();
  return data?.data ?? null;
}

async function saveToken(tok: { access_token: string; refresh_token: string; expires_at: number }) {
  await sb.from("source_results").upsert({
    query_norm: "spotify_oauth",
    source: "token",
    data: tok,
    fetched_at: new Date().toISOString(),
  });
}

async function createState(): Promise<string> {
  const nonce = crypto.randomUUID();
  await sb.from("source_results").upsert({
    query_norm: "spotify_oauth_state",
    source: nonce,
    data: { created: Date.now() },
    fetched_at: new Date().toISOString(),
  });
  return nonce;
}

async function consumeState(nonce: string | null): Promise<boolean> {
  if (!nonce || !/^[0-9a-f-]{36}$/i.test(nonce)) return false;
  const { data } = await sb.from("source_results").select("fetched_at").eq("query_norm", "spotify_oauth_state").eq("source", nonce).maybeSingle();
  await sb.from("source_results").delete().eq("query_norm", "spotify_oauth_state").eq("source", nonce);
  if (!data) return false;
  return Date.now() - new Date(data.fetched_at).getTime() < STATE_TTL;
}

async function freshAccessToken(): Promise<string> {
  const tok = await getToken();
  if (!tok?.refresh_token) throw new Error("not_connected");
  if (tok.access_token && Date.now() < (tok.expires_at ?? 0) - 60000) return tok.access_token;
  const { basic } = creds();
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error_description || j.error || `refresh ${res.status}`);
  const next = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || tok.refresh_token,
    expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
  };
  await saveToken(next);
  return next.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: H });
  const url = new URL(req.url);

  const code = url.searchParams.get("code");
  const oauthErr = url.searchParams.get("error");
  if (code || oauthErr) {
    if (oauthErr) return Response.redirect(`${APP_URL}?spotify_error=${encodeURIComponent(oauthErr)}`, 302);
    const state = url.searchParams.get("state");
    if (!(await consumeState(state))) return out({ error: "invalid or expired state" }, 401);
    try {
      const { basic } = creds();
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { Authorization: basic, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: REDIRECT_URI,
        }).toString(),
        signal: AbortSignal.timeout(10000),
      });
      const j = await res.json();
      if (!res.ok || !j.refresh_token) {
        return Response.redirect(`${APP_URL}?spotify_error=${encodeURIComponent(j.error_description || j.error || "token_failed")}`, 302);
      }
      await saveToken({
        access_token: j.access_token,
        refresh_token: j.refresh_token,
        expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
      });
      return Response.redirect(`${APP_URL}?spotify=connected`, 302);
    } catch (e) {
      return Response.redirect(`${APP_URL}?spotify_error=${encodeURIComponent(String((e as Error).message))}`, 302);
    }
  }

  const k = req.headers.get("x-app-key") ?? url.searchParams.get("k");
  if (!authOk(k)) return out({ error: "unauthorized" }, 401);
  const action = url.searchParams.get("action") ?? "status";

  if (action === "auth") {
    const { id } = creds();
    const state = await createState();
    const authUrl = new URL("https://accounts.spotify.com/authorize");
    authUrl.searchParams.set("client_id", id);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("scope", "user-library-modify user-library-read");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("show_dialog", "true");
    return Response.redirect(authUrl.toString(), 302);
  }

  if (action === "status") {
    const tok = await getToken();
    return out({ connected: !!tok?.refresh_token, redirectUri: REDIRECT_URI });
  }

  if (action === "check") {
    let id = String(url.searchParams.get("id") ?? "").trim();
    const rawUrl = String(url.searchParams.get("url") ?? "");
    const m = rawUrl.match(/\/(audiobook|show)\/([A-Za-z0-9]+)/);
    const kind = m?.[1] ?? "audiobook";
    if (!id && m) id = m[2];
    if (!/^[A-Za-z0-9]+$/.test(id)) return out({ saved: false });
    try {
      const access = await freshAccessToken();
      const uris = m ? `spotify:${kind}:${id}` : `spotify:audiobook:${id},spotify:show:${id}`;
      const res = await fetch(`https://api.spotify.com/v1/me/library/contains?uris=${encodeURIComponent(uris)}`, {
        headers: { Authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401 || res.status === 403) return out({ saved: false, needsReauth: true });
      if (!res.ok) return out({ saved: false });
      const arr = await res.json();
      return out({ saved: Array.isArray(arr) && arr.some(Boolean) });
    } catch (_) {
      return out({ saved: false });
    }
  }

  if (action === "save") {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    let id = String(url.searchParams.get("id") ?? body.id ?? "").trim();
    const rawUrl = String(body.url ?? url.searchParams.get("url") ?? "");
    const m = rawUrl.match(/\/(audiobook|show)\/([A-Za-z0-9]+)/);
    const kind = m?.[1] ?? "audiobook";
    if (!id && m) id = m[2];
    if (!/^[A-Za-z0-9]+$/.test(id)) return out({ error: "valid audiobook id required" }, 400);
    try {
      const access = await freshAccessToken();
      const saveUri = async (u: string) =>
        await fetch(`https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(u)}`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${access}` },
          signal: AbortSignal.timeout(10000),
        });
      let res = await saveUri(`spotify:${kind}:${id}`);
      if (res.status >= 500 && !m) {
        res = await saveUri(`spotify:show:${id}`);
      }
      if (res.ok || res.status === 200 || res.status === 204) return out({ ok: true, id, kind });
      const txt = await res.text();
      return out({ error: `spotify ${res.status}`, detail: txt.slice(0, 400) }, res.status);
    } catch (e) {
      const msg = String((e as Error).message);
      if (msg === "not_connected") return out({ error: "not_connected" }, 412);
      return out({ error: msg }, 502);
    }
  }

  return out({ error: "unknown action" }, 400);
});