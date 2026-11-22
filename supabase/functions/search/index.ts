import { createClient } from "npm:@supabase/supabase-js@2";

const authOk = (k: string | null) => {
  const raw = Deno.env.get("APP_ACCESS_KEY") ?? "";
  const keys = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return !!k && keys.includes(k);
};

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const H = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const TTL = 15 * 60 * 1000;
const UA = "Mozilla/5.0 (compatible; BookFinder/1.0)";
const E = encodeURIComponent;

type R = { source: string; title: string; author?: string; format?: string; available?: boolean; owned?: boolean; holds?: number; waitDays?: number; url: string; note?: string; rank?: string; cover?: string; description?: string; year?: number; series?: string };

const out = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: H });

const clean = (s?: string) => s ? s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 500) : undefined;

async function libby(q: string): Promise<R[]> {
  const u = `https://thunder.api.overdrive.com/v2/libraries/multcolib/media?query=${E(q)}&perPage=16&page=1&x-client-id=dewey`;
  const res = await fetch(u, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`libby ${res.status}`);
  const j = await res.json();
  return (j.items ?? [])
    .filter((i: any) => !i.languages?.length || i.languages.some((l: any) => String(l.id ?? "").toLowerCase() === "en" || /english/i.test(String(l.name ?? ""))))
    .map((i: any) => {
      const ds = i.detailedSeries;
      const series = ds?.seriesName ? (ds.readingOrder ? `${ds.seriesName} #${ds.readingOrder}` : ds.seriesName) : (i.series || undefined);
      const yr = i.publishDate ? Number(String(i.publishDate).slice(0, 4)) : 0;
      return {
        source: "libby", title: i.title, author: i.firstCreatorName, format: i.type?.name,
        owned: !!i.isOwned, available: !!i.isAvailable, holds: i.holdsCount,
        waitDays: i.isAvailable ? undefined : i.estimatedWaitDays,
        url: `https://multcolib.overdrive.com/media/${i.id}`,
        cover: i.covers?.cover150Wide?.href ?? i.covers?.cover300Wide?.href,
        description: clean(i.fullDescription ?? i.description),
        year: yr > 1000 ? yr : undefined,
        series,
      };
    });
}

const mclUrl = (q: string, f: string) =>
  `https://multcolib.bibliocommons.com/v2/search?query=${E(q)}&searchType=smart&locale=en-US&f_FORMAT=${f}`;

async function mcl(q: string, f: string): Promise<R[]> {
  const res = await fetch(mclUrl(q, f), { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`mcl ${res.status}`);
  const html = await res.text();
  const pos = new Map<string, number>();
  const ids: string[] = [];
  const re = /\/v2\/record\/(S\d+C\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) if (!pos.has(m[1])) { pos.set(m[1], m.index); ids.push(m[1]); }
  const items: R[] = [];
  for (let n = 0; n < Math.min(ids.length, 10); n++) {
    const start = pos.get(ids[n])!;
    const end = n + 1 < ids.length ? pos.get(ids[n + 1])! : html.length;
    const raw = html.slice(start, end);
    const text = raw.replace(/<[^>]+>/g, "");
    const pick = (r: RegExp) => text.match(r) ?? raw.match(r);
    const a = pick(/availability for (.+?), ([^,]+?), (Available|All copies in use|Unavailable|Not available|Coming soon|On order|In transit|Held for you)/);
    if (!a || /[\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF]/.test(a[1])) continue;
    const au = raw.match(/searchType=author[^>]*>\s*([^<]+?)\s*</);
    const h = text.match(/Holds:\s*(\d+)\s*on\s*(\d+)\s*copies/);
    items.push({
      source: "mcl", title: a[1], author: au?.[1], format: a[2],
      owned: true, available: a[3] === "Available", holds: h ? Number(h[1]) : undefined,
      url: `https://multcolib.bibliocommons.com/v2/record/${ids[n]}`,
    });
  }
  return items;
}

async function spotify(q: string): Promise<R[]> {
  const id = Deno.env.get("SPOTIFY_CLIENT_ID") ?? Deno.env.get("CLIENT_ID");
  const sec = Deno.env.get("SPOTIFY_CLIENT_SECRET") ?? Deno.env.get("CLIENT_SECRET");
  if (!id || !sec) return [];
  const tr = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${id}:${sec}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials", signal: AbortSignal.timeout(5000),
  });
  if (!tr.ok) throw new Error(`spotify token ${tr.status}`);
  const t = await tr.json();
  const res = await fetch(`https://api.spotify.com/v1/search?type=audiobook&market=US&limit=5&q=${E(q)}`, {
    headers: { Authorization: `Bearer ${t.access_token}` }, signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`spotify ${res.status}`);
  const j = await res.json();
  return (j.audiobooks?.items ?? [])
    .filter((i: any) => i && (!i.languages?.length || i.languages.some((l: string) => /^en\b/i.test(String(l)))))
    .map((i: any) => ({
      source: "spotify", id: i.id, title: i.name, author: i.authors?.[0]?.name, format: "Audiobook",
      url: i.external_urls?.spotify, note: "Premium inclusion not verified", cover: i.images?.[1]?.url ?? i.images?.[0]?.url,
      description: clean(i.description),
    }));
}

async function cached(qn: string, source: string, fn: () => Promise<R[]>): Promise<R[]> {
  const { data } = await sb.from("source_results").select("data,fetched_at").eq("query_norm", qn).eq("source", source).maybeSingle();
  if (data && Date.now() - new Date(data.fetched_at).getTime() < TTL) return data.data as R[];
  try {
    const r = await fn();
    await sb.from("source_results").upsert({ query_norm: qn, source, data: r, fetched_at: new Date().toISOString() });
    return r;
  } catch (e) {
    if (data) return data.data as R[];
    throw e;
  }
}

const norm = (s?: string) => (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const surname = (a?: string) => {
  if (!a) return "";
  const s = a.includes(",") ? a.split(",")[0] : a.trim().split(/\s+/).pop()!;
  return norm(s);
};
const flip = (a?: string) => (a && a.includes(",") ? a.split(",").slice(1).join(" ").trim() + " " + a.split(",")[0].trim() : a);

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

type Fix = { title: string; author: string; short: string };

async function thunderFuzz(q: string): Promise<Fix | null> {
  const toks = norm(q).split(" ").filter(Boolean);
  if (!toks.length) return null;
  let si = 0;
  toks.forEach((t, i) => { if (t.length > toks[si].length) si = i; });
  const w = toks[si];
  if (w.length < 4) return null;
  const first = new Set<string>(), later = new Set<string>();
  for (let i = 0; i < w.length; i++) {
    if ("aeiouy".includes(w[i])) for (const v of "aeiouy") if (v !== w[i]) first.add(w.slice(0, i) + v + w.slice(i + 1));
    first.add(w.slice(0, i) + w.slice(i + 1));
    first.add(w.slice(0, i) + w[i] + w.slice(i));
    if (i < w.length - 1) first.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
  }
  for (let i = 0; i <= w.length; i++) for (const v of "aeiou") later.add(w.slice(0, i) + v + w.slice(i));
  const cands = [...new Set([...first, ...later])].filter((x) => x !== w && x.length >= 3).slice(0, 30);
  const hits: ({ query: string; total: number; title: string; author: string } | null)[] = [];
  for (let i = 0; i < cands.length; i += 10) {
    const batch = await Promise.all(cands.slice(i, i + 10).map(async (cand) => {
      const qt = toks.map((t, j) => (j === si ? cand : t));
      try {
        const r = await fetch(`https://thunder.api.overdrive.com/v2/libraries/multcolib/media?query=${E(qt.join(" "))}&perPage=1&page=1&x-client-id=dewey`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return null;
        const j = await r.json();
        const it = j.items?.[0];
        if (!it || !(j.totalItems > 0)) return null;
        const hay = norm(`${it.title} ${it.firstCreatorName ?? ""}`);
        if (!qt.every((t) => hay.includes(t))) return null;
        return { query: qt.join(" "), total: j.totalItems as number, title: String(it.title), author: String(it.firstCreatorName ?? "") };
      } catch (_) { return null; }
    }));
    hits.push(...batch);
  }
  const ok = (hits.filter(Boolean) as { query: string; total: number; title: string; author: string }[]).sort((a, b) => b.total - a.total);
  if (!ok.length) return null;
  return { title: ok[0].title.split(":")[0].trim(), author: ok[0].author, short: ok[0].query };
}

const STOP = new Set(["the", "a", "an", "of", "and", "to", "in", "on", "for", "with"]);

async function resolve(q: string): Promise<Fix | null> {
  const nq = norm(q);
  const toks = nq.split(" ").filter(Boolean);
  if (!toks.length) return null;
  const limit = Math.max(2, Math.floor(nq.length * 0.3));
  const suspects = toks.map((t, i) => ({ t, i })).filter((x) => x.t.length >= 3 && !STOP.has(x.t));
  const found = await Promise.all(suspects.map(async ({ t, i }) => {
    const others = toks.filter((_, j) => j !== i).map((x) => `title:${x}`);
    let best: { title: string; author: string; d: number } | null = null;
    for (let L = t.length - 1; L >= Math.max(2, t.length - 4); L--) {
      const qq = [...others, `title:${t.slice(0, L)}*`].join(" AND ");
      try {
        const r = await fetch(`https://openlibrary.org/search.json?q=${E(qq)}&sort=editions&limit=20&fields=title,author_name`, { headers: { "User-Agent": "BookFinder/1.0" }, signal: AbortSignal.timeout(6000) });
        if (!r.ok) continue;
        const j = await r.json();
        for (const d of j.docs ?? []) {
          const nt = norm(d.title);
          const d2 = Math.min(lev(nq, nt), lev(nq, nt.split(" ").slice(0, toks.length).join(" ")));
          if (!best || d2 < best.d) best = { title: String(d.title).split(":")[0].trim(), author: d.author_name?.[0] ?? "", d: d2 };
        }
      } catch (_) { /* try next prefix */ }
      if (best && best.d <= limit) break;
    }
    return best;
  }));
  const best = (found.filter(Boolean) as { title: string; author: string; d: number }[]).sort((a, b) => a.d - b.d)[0];
  if (!best || best.d > limit) return null;
  const words = best.title.split(/\s+/);
  return { title: best.title, author: best.author, short: words.length > toks.length ? words.slice(0, toks.length).join(" ") : best.title };
}

async function resolveAuthor(q: string): Promise<Fix | null> {
  const nq = norm(q);
  const toks = nq.split(" ").filter(Boolean);
  if (!toks.length || (toks.length === 1 && toks[0].length < 3)) return null;
  const limit = Math.max(2, Math.floor(nq.length * 0.3));
  const deadline = Date.now() + 4800;
  type AuthorCand = { name: string; d: number; works: number };
  const state: { best: AuthorCand | null } = { best: null };

  const consider = (docs: any[]) => {
    for (const d of docs ?? []) {
      const rawName = typeof d?.name === "string" ? d.name.trim() : "";
      if (!rawName) continue;
      const name = (flip(rawName) ?? rawName).trim();
      const cn = norm(name);
      if (!cn) continue;
      const works = Number(d.work_count ?? 0);
      const fullDist = lev(nq, cn);
      const dist = toks.length === 1 ? Math.min(fullDist, lev(nq, surname(name))) : fullDist;
      const cand: AuthorCand = { name, d: dist, works };
      const cur = state.best;
      if (!cur) { state.best = cand; continue; }
      const cHas = cand.works > 0 ? 1 : 0, bHas = cur.works > 0 ? 1 : 0;
      if (cand.d <= limit && cur.d <= limit && cHas !== bHas) {
        if (cHas > bHas) state.best = cand;
      } else if (cand.d < cur.d || (cand.d === cur.d && cand.works > cur.works)) {
        state.best = cand;
      }
    }
  };

  const olAuthors = async (query: string, lim: number) => {
    const rem = deadline - Date.now();
    if (rem < 300) return;
    try {
      const r = await fetch(
        `https://openlibrary.org/search/authors.json?q=${E(query)}&limit=${lim}`,
        { headers: { "User-Agent": "BookFinder/1.0" }, signal: AbortSignal.timeout(Math.min(4500, rem)) },
      );
      if (!r.ok) return;
      const j = await r.json();
      consider(j.docs ?? []);
    } catch (_) { /* ignore */ }
  };

  const suspects = toks.map((t, i) => ({ t, i })).filter((x) => x.t.length >= 3);
  const fuzzyQ = toks.map((t) => (t.length >= 3 ? `${t}~` : t)).join(" ");

  await Promise.all([
    olAuthors(nq, 10),
    olAuthors(fuzzyQ, 10),
    ...suspects.map(async ({ t, i }) => {
      const others = toks.filter((_, j) => j !== i);
      for (let L = t.length - 1; L >= Math.max(2, t.length - 4); L--) {
        if (Date.now() >= deadline - 300) break;
        const qq = [...others, `${t.slice(0, L)}*`].join(" ");
        await olAuthors(qq, 15);
        if (state.best && state.best.d <= limit && state.best.works > 0) break;
      }
    }),
  ]);

  if ((!state.best || state.best.d > limit) && Date.now() < deadline - 400) {
    let si = toks.length - 1;
    if (toks[si].length < 3) {
      toks.forEach((t, i) => { if (t.length > toks[si].length) si = i; });
    }
    const w = toks[si];
    if (w.length >= 3) {
      const variants = new Set<string>();
      for (let i = 0; i < w.length; i++) {
        if (i < w.length - 1) variants.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
        if ("aeiouy".includes(w[i])) {
          for (const v of "aeiouy") if (v !== w[i]) variants.add(w.slice(0, i) + v + w.slice(i + 1));
        }
        variants.add(w.slice(0, i) + w.slice(i + 1));
      }
      if (w.length <= 5) {
        for (let i = 0; i <= w.length; i++) {
          for (const v of "aeiou") variants.add(w.slice(0, i) + v + w.slice(i));
        }
      }
      const cands = [...variants].filter((x) => x !== w && x.length >= 3).slice(0, 12);
      await Promise.all(cands.map((cand) => {
        const qt = toks.map((t, i) => (i === si ? cand : t)).join(" ");
        return olAuthors(qt, 10);
      }));
    }
  }

  if (!state.best || state.best.d > limit) return null;
  return { title: state.best.name, author: state.best.name, short: state.best.name };
}

function usedLinks(title: string, author?: string) {
  const e = E(`${title} ${author ?? ""}`.trim());
  return [
    { source: "ThriftBooks", url: `https://www.thriftbooks.com/browse/?b.search=${e}` },
    { source: "Better World Books", url: `https://www.betterworldbooks.com/search/results?q=${e}` },
    { source: "Amazon (used, low to high)", url: `https://www.amazon.com/s?s=price-asc-rank&k=${e}` },
  ];
}

async function olMeta(title: string, author?: string): Promise<{ cover?: string; year?: number }> {
  try {
    const u = `https://openlibrary.org/search.json?limit=1&fields=cover_i,first_publish_year&title=${E(title)}${author ? `&author=${E(author)}` : ""}`;
    const j = await (await fetch(u, { signal: AbortSignal.timeout(2500) })).json();
    const d = j.docs?.[0];
    return {
      cover: d?.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : undefined,
      year: typeof d?.first_publish_year === "number" ? d.first_publish_year : undefined,
    };
  } catch (_) { return {}; }
}

const VALID_STATUSES = new Set(["looking", "borrow_now", "library_hold", "buy_used", "got_it"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: H });
  const url = new URL(req.url);
  let q = url.searchParams.get("q"), k = req.headers.get("x-app-key") ?? url.searchParams.get("k");
  let body: any = {};
  if (req.method === "POST") {
    body = await req.json().catch(() => ({}));
    q = body.q ?? q; k = body.k ?? k;
  }
  if (!authOk(k)) return out({ error: "unauthorized" }, 401);

  const action = url.searchParams.get("action") ?? body.action;

  if (action === "update") {
    const id = url.searchParams.get("id") ?? body.id;
    const status = url.searchParams.get("status") ?? body.status;
    if (!id || !status || !VALID_STATUSES.has(status)) return out({ error: "id and valid status required" }, 400);
    const { error } = await sb.from("saved_items").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) return out({ error: error.message }, 500);
    return out({ ok: true });
  }

  if (action === "delete") {
    const id = url.searchParams.get("id") ?? body.id;
    if (!id) return out({ error: "id required" }, 400);
    const { error } = await sb.from("saved_items").delete().eq("id", id);
    if (error) return out({ error: error.message }, 500);
    return out({ ok: true });
  }

  if (url.searchParams.get("saved")) {
    const { data } = await sb.from("saved_items").select("id,query,status,best,updated_at").order("updated_at", { ascending: false });
    return out({ saved: data ?? [] });
  }

  q = (q ?? "").trim().slice(0, 200);
  if (!q) return out({ error: "q required: any one of title, author, or ISBN" }, 400);

  if (url.searchParams.get("debug") === "mcl") {
    const res = await fetch(mclUrl(q, "BK"), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    const html = await res.text();
    const i = html.search(/\/v2\/record\/S\d+C\d+/);
    return out({ status: res.status, length: html.length, recordAt: i, snippet: i < 0 ? html.slice(0, 1500) : html.slice(Math.max(0, i - 300), i + 2500) });
  }

  const qn = q.toLowerCase();
  const errors: string[] = [];
  const guard = (p: Promise<R[]>) => p.catch((e) => { errors.push(String(e.message ?? e)); return [] as R[]; });
  const gather = (query: string) => {
    const n = "en2:" + query.toLowerCase();
    return Promise.all([
      guard(cached(n, "libby", () => libby(query))),
      guard(cached(n, "spotify", () => spotify(query))),
      guard(cached(n, "mcl_BK", () => mcl(query, "BK"))),
      guard(cached(n, "mcl_AB", () => mcl(query, "AB"))),
    ]);
  };

  let usedQ = q;
  let corrected: { from: string; to: string; author?: string } | null = null;
  let [lib, spo, bk, ab] = await gather(q);

  const qt = norm(q).split(" ").filter(Boolean);
  const strong = (rs: R[]) => rs.some((r) => { const t = norm(r.title), a = norm(r.author); return qt.every((w) => t.includes(w)) || qt.every((w) => a.includes(w)); });
  if (!strong([...lib, ...bk, ...ab]) && !url.searchParams.get("exact")) {
    const [f1, f2, f3] = await Promise.all([thunderFuzz(q), resolve(q), resolveAuthor(q)]);
    for (const g of [f1, f2, f3]) {
      if (!g || corrected) continue;
      const combined = g.title === g.author ? g.title : `${g.title} ${g.author}`.trim();
      for (const attempt of [...new Set([g.short, combined, g.title])]) {
        const [l2, s2, b2, a2] = await gather(attempt);
        if (l2.length || b2.length || a2.length) { [lib, spo, bk, ab] = [l2, s2, b2, a2]; usedQ = attempt; corrected = { from: q, to: g === f1 ? g.title : g.short, author: g.author }; break; }
      }
    }
  }

  const order: string[] = [];
  const map = new Map<string, { title: string; author?: string; formats: R[] }>();
  for (const r of [...lib, ...bk, ...ab]) {
    const author = flip(r.author);
    const key = `${norm(r.title)}|${surname(r.author)}`;
    if (!map.has(key)) { map.set(key, { title: r.title, author, formats: [] }); order.push(key); }
    map.get(key)!.formats.push({ ...r, author });
  }

  const qq = norm(usedQ);
  const qq2 = qq.split(" ").filter(Boolean);
  const isCompanion = (title: string) =>
    /\b(unofficial|guide|companion|recipes|cookbook|trivia|quiz|workbook|summary|study guide|fan guide|tribute guide|world of|encyclopedia|analysis)\b/i.test(title);
  const tkey = (s?: string) => norm(s).replace(/^(the|a|an) /, "");
  const coreTitle = (s?: string) => tkey(String(s ?? "").split(":")[0]);
  let primaryAuthor = "";
  for (const key of order) {
    const w = map.get(key)!;
    if (norm(w.title) === qq && w.author && !isCompanion(w.title)) {
      primaryAuthor = surname(w.author);
      break;
    }
  }
  const relevance = (w: { title: string; author?: string }) => {
    const n = norm(w.title), a = norm(w.author);
    const comp = isCompanion(w.title) ? 10 : 0;
    const sameAuth = primaryAuthor && surname(w.author) === primaryAuthor;
    if (n === qq) return (comp ? 5 : 0) + (sameAuth ? 0 : 1);
    if (sameAuth) return 1 + comp;
    if (qq2.length && qq2.every((t) => a.includes(t))) return 2 + comp;
    if (n.includes(qq)) return 3 + comp;
    return 4 + comp;
  };
  const includeRead = !!url.searchParams.get("includeRead");
  let readList: { title?: string; author?: string }[] = [];
  if (!includeRead) {
    const { data: gr } = await sb.from("source_results").select("data").eq("query_norm", "goodreads").eq("source", "read").maybeSingle();
    if (Array.isArray(gr?.data)) readList = gr.data;
  }
  const isRead = (w: { title: string; author?: string }) => {
    if (!readList.length) return false;
    const x = tkey(w.title), cx = coreTitle(w.title), s1 = surname(w.author);
    return readList.some((b) => {
      const y = tkey(b.title), cy = coreTitle(b.title);
      if (!x || !y) return false;
      if (x !== y && (!cx || cx !== cy)) return false;
      const s2 = surname(b.author);
      return !s1 || !s2 || s1 === s2;
    });
  };

  let skippedRead = 0;
  const allRanked = order
    .map((key, i) => ({ key, i, s: relevance(map.get(key)!) }))
    .sort((a, b) => a.s - b.s || a.i - b.i);
  const keys = allRanked.filter(({ key }) => {
    if (!includeRead && isRead(map.get(key)!)) { skippedRead++; return false; }
    return true;
  }).slice(0, 8);

  const works = await Promise.all(keys.map(async ({ key }) => {
    const w = map.get(key)!;
    for (const s of spo) {
      const titleMatch = norm(s.title).includes(norm(w.title)) || norm(w.title).includes(norm(s.title));
      const authorMatch = !s.author || !w.author || surname(s.author) === surname(w.author);
      if (titleMatch && authorMatch) w.formats.push(s);
    }
    const rank = (r: R) => r.source === "spotify" ? 2 : r.available ? 0 : r.owned ? 1 : 3;
    const formats = w.formats
      .map((r) => ({ ...r, rank: ["borrow_now", "hold", "spotify", "not_owned"][rank(r)] }))
      .sort((a, b) => rank(a) - rank(b) || (a.waitDays ?? 1e9) - (b.waitDays ?? 1e9));
    const borrowable = formats.some((f) => f.rank === "borrow_now");
    const status = borrowable ? "borrow_now" : formats.some((f) => f.rank === "hold") ? "library_hold" : "buy_used";
    const meta = await olMeta(w.title, w.author);
    const cover = formats.find((f) => f.cover)?.cover ?? meta.cover;
    const years = formats.map((f) => f.year).filter((y): y is number => !!y);
    const year = meta.year ?? (years.length ? Math.min(...years) : undefined);
    const series = formats.find((f) => f.series)?.series;
    const description = formats.find((f) => f.description)?.description;
    return { title: w.title, author: w.author, year, series, cover, description, status, formats, used: borrowable ? null : usedLinks(w.title, w.author) };
  }));

  const primary = works[0] ?? null;
  const status = primary?.status ?? "buy_used";
  const best = primary ? { title: primary.title, author: primary.author, cover: primary.cover, status, top: primary.formats[0] ?? null } : null;
  const used = primary ? primary.used : usedLinks(corrected?.to ?? q, corrected?.author);
  const now = new Date().toISOString();
  const { data: ex } = await sb.from("saved_items").select("id,status").eq("query_norm", qn).maybeSingle();
  if (ex) await sb.from("saved_items").update({ status: ex.status === "got_it" ? "got_it" : status, best, updated_at: now }).eq("id", ex.id);
  else await sb.from("saved_items").insert({ query: q, query_norm: qn, status, best });

  return out({ query: q, corrected, status, primary, others: works.slice(1), used, errors, skippedRead, saved: true });
});