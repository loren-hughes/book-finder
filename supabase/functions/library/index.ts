import { createClient } from "npm:@supabase/supabase-js@2";

const authOk = (k: string | null) => {
  const raw = Deno.env.get("APP_ACCESS_KEY") ?? "";
  const keys = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return !!k && keys.includes(k);
};
const BASE = "https://multcolib.bibliocommons.com";
const GW = "https://gateway.bibliocommons.com/v2";
const UA = "Mozilla/5.0 (compatible; BookFinder/1.0)";
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const H = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });
const strip = (h: string) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

class Session {
  jar = new Map<string, string>();
  authToken = "";
  sessionId = "";
  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  absorb(r: Response) {
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  async go(u: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}, max = 6) {
    let method = init.method ?? "GET", body = init.body, cur = u, extra = { ...(init.headers ?? {}) };
    for (let n = 0; n <= max; n++) {
      const res = await fetch(cur, {
        method, body, redirect: "manual", signal: AbortSignal.timeout(12000),
        headers: { "User-Agent": UA, Accept: "text/html,application/json", Cookie: this.cookieHeader(), ...extra },
      });
      this.absorb(res);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        const nextUrl = new URL(loc, cur);
        if (!nextUrl.hostname.endsWith(".bibliocommons.com")) throw new Error("blocked redirect");
        cur = nextUrl.toString();
        method = "GET"; body = undefined; delete extra["Content-Type"];
        await res.text();
        continue;
      }
      return { res, body: await res.text(), url: cur };
    }
    throw new Error("too many redirects");
  }
}

async function login(s: Session): Promise<{ ok: boolean; why?: string }> {
  const card = Deno.env.get("LIBRARY_CARD_NUMBER"), pin = Deno.env.get("LIBRARY_PIN");
  if (!card || !pin) return { ok: false, why: "missing secrets" };
  const page = await s.go(BASE + "/user/login");
  const i = page.body.indexOf('class="loginForm');
  const seg = i >= 0 ? page.body.slice(i) : page.body;
  const tag = seg.match(/<input[^>]*name="authenticity_token"[^>]*>/)?.[0] ?? "";
  const token = tag.match(/value="([^"]+)"/)?.[1];
  if (!token) return { ok: false, why: "no csrf token" };
  const form = new URLSearchParams({ utf8: "\u2713", authenticity_token: token, name: card, user_pin: pin, local: "false", commit: "Log In" });
  const r = await s.go(BASE + "/user/login?destination=%2Fuser_dashboard", {
    method: "POST", body: form.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE, Referer: BASE + "/user/login" },
  });
  const loggedIn = !/\/user\/login/.test(r.url) && /log ?out|sign ?out/i.test(r.body);
  if (loggedIn) return { ok: true };
  const msg = strip(r.body).match(/(invalid|incorrect|not recognized|try again|locked|expired)[^.]{0,120}/i)?.[0];
  return { ok: false, why: msg ?? "login failed" };
}

function getState(html: string): any | null {
  const re = /<script[^>]*data-iso-key="[^"]*"[^>]*>([\s\S]*?)<\/script>/gi;
  let best: any = null, m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try { const j = JSON.parse(m[1]); if (j?.entities) best = j; } catch (_) { /* skip */ }
  }
  return best;
}

async function page(s: Session, p: string, qs = "") {
  const r = await s.go(`${BASE}/v2/${p}${qs}`);
  const st = getState(r.body);
  if (!s.authToken) s.authToken = st?.auth?.authToken ?? r.body.match(/"authToken":"([^"]+)"/)?.[1] ?? "";
  if (!s.sessionId) s.sessionId = st?.auth?.sessionId ?? r.body.match(/"sessionId":"([^"]+)"/)?.[1] ?? "";
  return { st, html: r.body };
}

async function gw(s: Session, method: string, path: string, body?: string) {
  const token = s.jar.get("bc_access_token") ?? s.authToken ?? "";
  const sid = s.jar.get("session_id") ?? s.sessionId ?? "";
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${GW}${path}${sep}locale=en-US`, {
    method, body, signal: AbortSignal.timeout(15000),
    headers: {
      "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json", Origin: BASE, Referer: BASE + "/",
      ...(token ? { "X-Access-Token": token } : {}),
      ...(sid ? { "X-Session-Id": sid } : {}),
      Cookie: s.cookieHeader(),
    },
  });
  return { status: r.status, body: await r.text() };
}

function fmtKind(format?: string, mat?: string) {
  const f = String(format ?? "").toUpperCase();
  if (f === "EBOOK" || f === "E-BOOK") return "Ebook";
  if (f === "EAUDIOBOOK" || f === "AUDIOBOOK" || f === "AB") return "Audiobook";
  if (f === "BK") return "Book";
  return mat === "DIGITAL" ? "Ebook" : "Book";
}

function getAccountId(hp: { st: any; html: string }) {
  const accs = Object.values(hp.st?.entities?.accounts ?? {}) as any[];
  if (accs[0]?.id != null) return accs[0].id;
  return hp.html.match(/"accountId":"(\d+)"/)?.[1] ?? hp.st?.auth?.currentUserId;
}

const DUMMY = "S152C0000000";
const VALID_PK = new Set(["branchId", "pickupLocationId", "pickupLocation", "pickupBranch", "pickupLocationCode"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: H });
  const url = new URL(req.url);
  if (!authOk(req.headers.get("x-app-key") ?? url.searchParams.get("k"))) return out({ error: "unauthorized" }, 401);
  const action = url.searchParams.get("action") ?? "account";
  const s = new Session();
  const l = await login(s);
  if (!l.ok) return out({ error: "login failed", why: l.why }, 502);

  if (action === "placehold") {
    const id = url.searchParams.get("id") ?? "";
    if (!/^S\d+C\d+$/.test(id) || id === DUMMY) return out({ error: "bad id" }, 400);
    if (url.searchParams.get("confirm") !== "1") return out({ error: "confirm=1 required" }, 400);
    const hp = await page(s, "holds");
    const accountId = getAccountId(hp);
    if (!accountId) return out({ error: "no account id" }, 502);
    const tally = new Map<string, number>();
    for (const h of Object.values(hp.st?.entities?.holds ?? {}) as any[]) { const c = h.pickupLocation?.code; if (c) tally.set(c, (tally.get(c) ?? 0) + 1); }
    const rawPickup = url.searchParams.get("pickup");
    if (rawPickup && !/^[A-Z0-9]{2,8}$/.test(rawPickup)) return out({ error: "bad pickup code" }, 400);
    const pickup = rawPickup ?? [...tally].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!pickup) return out({ error: "no pickup branch" }, 400);
    const rawPk = url.searchParams.get("pk") ?? "branchId";
    const key = VALID_PK.has(rawPk) ? rawPk : "branchId";
    const payload = {
      accountId,
      metadataId: id,
      materialType: "PHYSICAL",
      enableSingleClickHolds: false,
      materialParams: { [key]: pickup, expiryDate: null, errorMessageLocale: "en-US" },
    };
    const r = await gw(s, "POST", "/libraries/multcolib/holds", JSON.stringify(payload));
    await sb.from("hold_log").insert({
      metadata_id: id,
      request: {
        ...payload,
        accountId: "(hidden)",
        hasAccessToken: !!(s.jar.get("bc_access_token") || s.authToken),
        hasSessionId: !!(s.jar.get("session_id") || s.sessionId),
        sameAccountAndUser: String(hp.st?.auth?.currentUserId ?? "") === String(accountId),
        cookieKeys: [...s.jar.keys()],
      },
      status: r.status,
      response: r.body.slice(0, 2000),
    });
    return out({ status: r.status, pickup, body: r.body.slice(0, 1500) });
  }

  if (action === "cancelhold") {
    const id = url.searchParams.get("id") ?? "";
    const holdsId = url.searchParams.get("holdsId") ?? "";
    if (!/^S\d+C\d+$/.test(id) || !holdsId) return out({ error: "id and holdsId required" }, 400);
    if (url.searchParams.get("confirm") !== "1") return out({ error: "confirm=1 required" }, 400);
    const hp = await page(s, "holds");
    const accountId = getAccountId(hp);
    if (!accountId) return out({ error: "no account id" }, 502);
    const payload = { accountId, metadataIds: [id], holdIds: [holdsId] };
    const r = await gw(s, "DELETE", "/libraries/multcolib/holds", JSON.stringify(payload));
    await sb.from("hold_log").insert({ metadata_id: id, request: { action: "cancel", holdsId, accountId: "(hidden)" }, status: r.status, response: r.body.slice(0, 2000) });
    return out({ status: r.status, body: r.body.slice(0, 1500) });
  }

  if (action === "forlater") {
    let id = url.searchParams.get("id") ?? "";
    if (!id) {
      const q = (url.searchParams.get("q") ?? "").trim();
      const wantKind = (url.searchParams.get("kind") ?? "").toLowerCase();
      if (!q) return out({ error: "id or q required" }, 400);
      const sr = await fetch(`${BASE}/v2/search?query=${encodeURIComponent(q)}&searchType=smart`, {
        headers: { "User-Agent": UA, Accept: "text/html" },
        signal: AbortSignal.timeout(10000),
      });
      const html = await sr.text();
      const pos = new Map<string, number>();
      const ids: string[] = [];
      const re = /\/v2\/record\/(S\d+C\d+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html))) if (!pos.has(m[1])) { pos.set(m[1], m.index); ids.push(m[1]); }
      for (let n = 0; n < Math.min(ids.length, 10); n++) {
        const start = pos.get(ids[n])!;
        const end = n + 1 < ids.length ? pos.get(ids[n + 1])! : html.length;
        const text = html.slice(start, end).replace(/<[^>]+>/g, "");
        const a = text.match(/availability for (.+?), ([^,]+?),/);
        const fmt = (a?.[2] ?? "").toLowerCase();
        if (wantKind === "ebook" && /ebook|e-book|overdrive/i.test(fmt)) { id = ids[n]; break; }
        if (wantKind === "audiobook" && /audio/i.test(fmt)) { id = ids[n]; break; }
      }
      if (!id && ids.length) id = ids[0];
    }
    if (!/^S\d+C\d+$/.test(id) || id === DUMMY) return out({ error: "could not find Multnomah record" }, 404);
    const hp = await page(s, "holds");
    const userId = hp.st?.auth?.currentUserId ?? getAccountId(hp);
    if (!userId) return out({ error: "no user id" }, 502);
    const payload = { metadataIds: [id], shelfName: "for_later", userId };
    const r = await gw(s, "POST", "/libraries/multcolib/shelves/", JSON.stringify(payload));
    return out({ status: r.status, id, body: r.body.slice(0, 1500) });
  }

  if (action === "forlater_list") {
    const hp = await page(s, "holds");
    const userId = hp.st?.auth?.currentUserId ?? getAccountId(hp);
    if (!userId) return out({ error: "no user id" }, 502);
    const items: any[] = [];
    const seen = new Set<string>();
    let total = 0;
    for (let pg = 1; pg <= 10; pg++) {
      const r = await gw(s, "GET", `/libraries/multcolib/shelves/for_later?userId=${encodeURIComponent(String(userId))}&limit=50&page=${pg}`);
      if (r.status < 200 || r.status >= 300) {
        if (pg === 1) return out({ error: `shelves ${r.status}`, body: r.body.slice(0, 500) }, 502);
        break;
      }
      let j: any;
      try { j = JSON.parse(r.body); } catch {
        if (pg === 1) return out({ error: "shelves invalid json", body: r.body.slice(0, 500) }, 502);
        break;
      }
      const bibs = j.entities?.bibs ?? {};
      const pageItems = Object.values(bibs).map((bib: any) => {
        const b = bib?.briefInfo;
        const av = bib?.availability;
        return {
          id: bib?.id ?? b?.id,
          title: b?.title,
          author: b?.authors?.[0],
          format: b?.format,
          cover: b?.jacket?.medium ?? b?.jacket?.small,
          available: av ? (av.status === "AVAILABLE" || av.statusType === "AVAILABLE" || (av.availableCopies ?? 0) > 0) : undefined,
          availCopies: av?.availableCopies,
          totalCopies: av?.totalCopies,
          holds: av?.heldCopies,
        };
      }).filter((x) => x.id && x.title);
      for (const it of pageItems) {
        if (!seen.has(it.id)) {
          seen.add(it.id);
          items.push(it);
        }
      }
      const pag = j.shelves?.for_later?.pagination ?? j.shelves?.pagination;
      if (pag?.count) total = pag.count;
      const pages = pag?.pages;
      if (pages ? pg >= pages : pageItems.length < 50) break;
    }
    return out({ count: items.length, items, total: total || items.length });
  }

  if (action === "forlater_remove") {
    const id = url.searchParams.get("id") ?? "";
    const shelfItemId = url.searchParams.get("shelfItemId") ?? "";
    if (!/^S\d+C\d+$/.test(id) && !shelfItemId) return out({ error: "id or shelfItemId required" }, 400);
    const hp = await page(s, "holds");
    const userId = hp.st?.auth?.currentUserId ?? getAccountId(hp);
    if (!userId) return out({ error: "no user id" }, 502);
    const payload: any = { userId };
    if (id) payload.metadataIds = [id];
    if (shelfItemId) payload.shelfItemIds = [shelfItemId];
    const r = await gw(s, "DELETE", "/libraries/multcolib/shelves/for_later", JSON.stringify(payload));
    return out({ status: r.status, body: r.body.slice(0, 1500) });
  }

  if (action === "checkin") {
    const id = url.searchParams.get("id") ?? "";
    const checkoutId = url.searchParams.get("checkoutId") ?? "";
    if (!/^S\d+C\d+$/.test(id) || !checkoutId) return out({ error: "id and checkoutId required" }, 400);
    if (url.searchParams.get("confirm") !== "1") return out({ error: "confirm=1 required" }, 400);
    const hp = await page(s, "holds");
    const accountId = getAccountId(hp);
    if (!accountId) return out({ error: "no account id" }, 502);
    const r = await gw(s, "DELETE", `/libraries/multcolib/checkouts/${encodeURIComponent(checkoutId)}`, JSON.stringify({ metadataId: id, accountId }));
    return out({ status: r.status, body: r.body.slice(0, 1500) });
  }

  if (action === "renew") {
    const checkoutId = url.searchParams.get("checkoutId") ?? "";
    if (!checkoutId) return out({ error: "checkoutId required" }, 400);
    if (url.searchParams.get("confirm") !== "1") return out({ error: "confirm=1 required" }, 400);
    const hp = await page(s, "holds");
    const accountId = getAccountId(hp);
    if (!accountId) return out({ error: "no account id" }, 502);
    const payload = { accountId, checkoutIds: [checkoutId], renew: true };
    const r = await gw(s, "PATCH", "/libraries/multcolib/checkouts", JSON.stringify(payload));
    return out({ status: r.status, body: r.body.slice(0, 1500) });
  }

  if (action === "suspendhold") {
    const id = url.searchParams.get("id") ?? "";
    const holdsId = url.searchParams.get("holdsId") ?? "";
    const suspend = url.searchParams.get("suspend") !== "0";
    const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 365);
    if (!/^S\d+C\d+$/.test(id) || !holdsId) return out({ error: "id and holdsId required" }, 400);
    if (url.searchParams.get("confirm") !== "1") return out({ error: "confirm=1 required" }, 400);
    const hp = await page(s, "holds");
    const accountId = getAccountId(hp);
    if (!accountId) return out({ error: "no account id" }, 502);
    const end = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const payload: any = {
      accountId,
      holdIds: [holdsId],
      suspended: suspend ? { status: true, endDate: end } : { status: false },
    };
    const r = await gw(s, "PATCH", "/libraries/multcolib/holds", JSON.stringify(payload));
    await sb.from("hold_log").insert({ metadata_id: id, request: { action: suspend ? "suspend" : "resume", holdsId, end: suspend ? end : null, accountId: "(hidden)" }, status: r.status, response: r.body.slice(0, 2000) });
    return out({ status: r.status, suspended: suspend, endDate: suspend ? end : undefined, body: r.body.slice(0, 1500) });
  }

  if (action === "account") {
    const pages = Math.min(Number(url.searchParams.get("pages") ?? 1), 4);
    const checkouts: any[] = [];
    let summary: any = null, total = 0;
    for (let p = 1; p <= pages; p++) {
      const { st } = await page(s, "checkedout", p > 1 ? `?page=${p}` : "");
      if (!st) continue;
      const bibs = st.entities?.bibs ?? {};
      for (const [ckey, c] of Object.entries(st.entities?.checkouts ?? {}) as [string, any][]) {
        const b = bibs[c.metadataId]?.briefInfo;
        checkouts.push({
          title: b?.title ?? c.bibTitle, volume: c.volume || undefined, author: b?.authors?.[0],
          kind: fmtKind(b?.format, c.materialType), digital: c.materialType === "DIGITAL", due: c.dueDate, status: c.status, id: c.metadataId,
          checkoutId: c.checkoutId ?? c.id ?? ckey,
          actions: Array.isArray(c.actions) ? c.actions : undefined,
        });
      }
      summary ??= st.borrowing?.checkedout?.summary;
      total = st.borrowing?.checkedout?.pagination?.count ?? total;
    }
    checkouts.sort((a, b) => String(a.due).localeCompare(String(b.due)));

    const holds: any[] = [];
    const seen = new Set<string>();
    let hpages = 1;
    for (let p = 1; p <= hpages && p <= 4; p++) {
      const { st: hs } = await page(s, "holds", p > 1 ? `?page=${p}` : "");
      if (!hs) continue;
      hpages = hs.borrowing?.holds?.pagination?.pages ?? 1;
      const hbibs = hs.entities?.bibs ?? {};
      for (const h of Object.values(hs.entities?.holds ?? {}) as any[]) {
        if (seen.has(h.holdsId)) continue;
        seen.add(h.holdsId);
        const b = hbibs[h.metadataId]?.briefInfo;
        const av = hbibs[h.metadataId]?.availability;
        const copies = av?.totalCopies ?? h.copies;
        const pos = h.holdsPosition ?? h.position;
        const isDig = h.materialType === "DIGITAL";
        const estDays = !isDig && pos > 0 && copies > 0 ? Math.max(7, Math.ceil((pos / copies) * 21)) : undefined;
        holds.push({
          title: b?.title ?? h.bibTitle ?? h.title,
          author: b?.authors?.[0],
          status: h.status,
          position: pos,
          copies,
          kind: fmtKind(b?.format, h.materialType),
          digital: isDig,
          waitDays: estDays,
          id: h.metadataId,
          holdsId: h.holdsId,
          suspended: !!h.suspended?.status || h.status === "SUSPENDED",
          suspendEnd: h.suspended?.endDate,
          actions: Array.isArray(h.actions) ? h.actions : undefined,
          pickup: h.pickupLocation?.name ?? h.pickupBranch,
          pickupBy: h.pickupByDate || undefined,
        });
      }
    }
    const digWaiting = holds.filter((h) => h.digital && h.status !== "READY_FOR_PICKUP" && h.title);
    await Promise.all(digWaiting.map(async (h) => {
      try {
        const q = encodeURIComponent(`${h.title} ${h.author ?? ""}`.trim());
        const r = await fetch(`https://thunder.api.overdrive.com/v2/libraries/multcolib/media?query=${q}&perPage=3&page=1&x-client-id=dewey`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) return;
        const j = await r.json();
        const wantFmt = h.kind === "Audiobook" ? "audiobook" : "ebook";
        const m = (j.items ?? []).find((x: any) => String(x.type?.id ?? "").toLowerCase().includes(wantFmt)) ?? j.items?.[0];
        if (typeof m?.estimatedWaitDays === "number" && m.estimatedWaitDays > 0) h.waitDays = m.estimatedWaitDays;
      } catch (_) { /* ignore */ }
    }));
    return out({ checkedOut: { total, shown: checkouts.length, summary: summary?.status, nextDue: summary?.nextDue, items: checkouts }, holds: { count: holds.length, items: holds } });
  }
  return out({ error: "unknown action" }, 400);
});