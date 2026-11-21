import { createClient } from "npm:@supabase/supabase-js@2";

const authOk = (k: string | null) => {
  const raw = Deno.env.get("APP_ACCESS_KEY") ?? "";
  const keys = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return !!k && keys.includes(k);
};

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const H = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const TTL = 6 * 3600 * 1000;
const UA = "Mozilla/5.0 (compatible; BookFinder/1.0)";
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });
const E = encodeURIComponent;
const norm = (s?: string) => (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const tkey = (s?: string) => norm(s).replace(/^(the|a|an) /, "");
const surname = (a?: string) => { if (!a) return ""; const s = a.includes(",") ? a.split(",")[0] : a.trim().split(/\s+/).pop()!; return norm(s); };
const flip = (a?: string) => (a && a.includes(",") ? a.split(",").slice(1).join(" ").trim() + " " + a.split(",")[0].trim() : (a ?? ""));
const pretty = (slug: string) => slug.replace(/_/g, " ");

type Cand = { title: string; author: string; year?: number; cover?: string; score: number; why: string[]; editions: number };
type MclResult = { status: "borrow_now" | "hold" | "none"; format?: string; holds?: number; url?: string };

async function ol(u: string) {
  try {
    const r = await fetch(u, { headers: { "User-Agent": "BookFinder/1.0" }, signal: AbortSignal.timeout(9000) });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
}

async function libby(title: string, author: string) {
  try {
    const r = await fetch(`https://thunder.api.overdrive.com/v2/libraries/multcolib/media?query=${E((title + " " + author).trim())}&perPage=6&page=1&x-client-id=dewey`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    const want = tkey(title), sn = surname(author);
    const items = (j.items ?? []).filter((i: any) => {
      const t = tkey(i.title);
      return (t.includes(want) || want.includes(t)) && (!sn || norm(i.firstCreatorName).includes(sn));
    });
    if (!items.length) return { status: "none", formats: [] };
    const formats = items.map((i: any) => ({
      format: i.type?.name, available: !!i.isAvailable, owned: !!i.isOwned,
      waitDays: i.isAvailable ? undefined : i.estimatedWaitDays, holds: i.holdsCount, url: `https://multcolib.overdrive.com/media/${i.id}`,
    }));
    const avail = formats.find((f: any) => f.available);
    const holds = formats.filter((f: any) => f.owned && !f.available).sort((a: any, b: any) => (a.waitDays ?? 1e9) - (b.waitDays ?? 1e9))[0];
    return {
      status: avail ? "borrow_now" : holds ? "hold" : "none", formats,
      best: avail ?? holds, cover: items.find((i: any) => i.covers)?.covers?.cover150Wide?.href,
    };
  } catch (_) { return null; }
}

async function mclPrint(title: string, author: string): Promise<MclResult | null> {
  try {
    const u = `https://multcolib.bibliocommons.com/v2/search?query=${E((title + " " + author).trim())}&searchType=smart&locale=en-US&f_FORMAT=BK`;
    const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const html = await r.text();
    const pos = new Map<string, number>();
    const ids: string[] = [];
    const re = /\/v2\/record\/(S\d+C\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) if (!pos.has(m[1])) { pos.set(m[1], m.index); ids.push(m[1]); }
    const want = tkey(title), sn = surname(author);
    const matches: { available: boolean; format: string; holds?: number; url: string }[] = [];
    for (let n = 0; n < Math.min(ids.length, 6); n++) {
      const start = pos.get(ids[n])!;
      const end = n + 1 < ids.length ? pos.get(ids[n + 1])! : html.length;
      const raw = html.slice(start, end);
      const text = raw.replace(/<[^>]+>/g, "");
      const pick = (rx: RegExp) => text.match(rx) ?? raw.match(rx);
      const a = pick(/availability for (.+?), ([^,]+?), (Available|All copies in use|Unavailable|Not available|Coming soon|On order|In transit|Held for you)/);
      if (!a) continue;
      const t = tkey(a[1]);
      if (!t || !(t.includes(want) || want.includes(t))) continue;
      const au = raw.match(/searchType=author[^>]*>\s*([^<]+?)\s*</);
      if (sn && au?.[1] && !norm(au[1]).includes(sn)) continue;
      const h = text.match(/Holds:\s*(\d+)\s*on\s*(\d+)\s*copies/);
      matches.push({
        available: a[3] === "Available",
        format: a[2],
        holds: h ? Number(h[1]) : undefined,
        url: `https://multcolib.bibliocommons.com/v2/record/${ids[n]}`,
      });
    }
    if (!matches.length) return { status: "none" };
    const avail = matches.find((x) => x.available);
    if (avail) return { status: "borrow_now", format: avail.format, holds: avail.holds, url: avail.url };
    const bestHold = matches.sort((a, b) => (a.holds ?? 1e9) - (b.holds ?? 1e9))[0];
    return { status: "hold", format: bestHold.format, holds: bestHold.holds, url: bestHold.url };
  } catch (_) { return null; }
}

// Subjects that say nothing about taste (generic, geographic, children's, or tied to one book's setting).
const CHILDREN_SUBJ = /\b(children|juvenile|picture books?|board books?|early readers?|stories in rhyme|bedtime|preschool|kindergarten|fairy tales?)\b/i;
const KID_BOOK = /\b(juvenile fiction|juvenile literature|children's stories|children's fiction|picture books?|board books?|early readers?|stories in rhyme|bedtime stories|preschool|kindergarten)\b/i;
const isKidsBook = (subs?: unknown) => Array.isArray(subs) && subs.some((x) => KID_BOOK.test(String(x)));

const GENERIC = /^(fiction|general|novel|novels|american fiction|english fiction|fiction, general|large type books|accessible book|protected daisy|in library|nonfiction|non-fiction|history|biography|translations into english|english language|juvenile fiction|juvenile literature|children's stories|picture books|board books|early readers|stories in rhyme|bedtime|preschool|kindergarten|fairy tales|books and reading|readers)$/;
const junk = (s: string) =>
  GENERIC.test(s) ||
  CHILDREN_SUBJ.test(s) ||
  /^(nyt:|reading level|lending library|internet archive|open_syllabus|new york times|long now|overdrive|large print|bestseller)/.test(s) ||
  /(united states|north america|indians|history|politics|study and teaching|juvenile)/.test(s) ||
  s.length > 45 ||
  /\d{4}/.test(s);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: H });
  const url = new URL(req.url);
  if (!authOk(req.headers.get("x-app-key") ?? url.searchParams.get("k"))) return out({ error: "unauthorized" }, 401);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const since = Math.min(Math.max(Number(body.since) || 1995, 1800), 2026);
  const exclude: { title: string; author?: string }[] = (body.exclude ?? []).slice(0, 800);
  const seeds: { title: string; author?: string; w?: number }[] = (body.seeds ?? []).slice(0, 40);

  let genres: string[] = (body.genres ?? []).map((g: string) => String(g).toLowerCase().trim().replace(/\s+/g, "_")).filter(Boolean).slice(0, 8);
  let authors: string[] = (body.authors ?? []).map((a: string) => String(a).trim()).filter(Boolean).slice(0, 8);

  // Taste profile from your own books: most common subjects, and the authors you lean on.
  if (seeds.length) {
    const subj = new Map<string, number>(), auth = new Map<string, { name: string; w: number }>();
    for (const s of seeds) {
      const a = flip(s.author).trim();
      if (a) { const k = norm(a); auth.set(k, { name: a, w: (auth.get(k)?.w ?? 0) + (s.w ?? 1) }); }
    }
    const top = [...seeds].sort((a, b) => (b.w ?? 1) - (a.w ?? 1)).slice(0, 24);
    await Promise.all(top.map(async (s) => {
      const j = await ol(`https://openlibrary.org/search.json?title=${E(s.title)}${s.author ? `&author=${E(flip(s.author))}` : ""}&limit=1&fields=subject`);
      const subs: string[] = (j?.docs?.[0]?.subject ?? []).map((x: string) => String(x).toLowerCase().trim());
      for (const x of new Set(subs)) if (x && !junk(x)) subj.set(x, (subj.get(x) ?? 0) + (s.w ?? 1));
    }));
    const ranked = [...subj].sort((a, b) => b[1] - a[1]);
    const multi = ranked.filter((x) => x[1] >= 3).slice(0, 4);
    genres = (multi.length ? multi : ranked.slice(0, 3)).map((x) => x[0].replace(/\s+/g, "_"));
    authors = [...auth.values()].sort((a, b) => b.w - a.w).slice(0, 4).map((x) => x.name);
  }
  if (!genres.length && !authors.length) return out({ error: "Not enough history to base recommendations on yet" }, 400);

  const wantsChildren = genres.some((g) => CHILDREN_SUBJ.test(pretty(g)));
  const ckey = "r5:" + norm(genres.join(",") + "|" + authors.join(",") + "|" + since);
  const { data: hit } = await sb.from("source_results").select("data,fetched_at").eq("query_norm", ckey).eq("source", "recs").maybeSingle();
  let pool: Cand[];
  if (hit && !url.searchParams.get("refresh") && Date.now() - new Date(hit.fetched_at).getTime() < TTL) pool = hit.data;
  else {
    const map = new Map<string, Cand>();
    const add = (title: string, author: string, extra: Partial<Cand>, why: string, w: number) => {
      if (!title || !author) return;
      const key = tkey(title) + "|" + surname(author);
      const c = map.get(key) ?? { title, author, score: 0, why: [], editions: 0 };
      c.score += w; if (!c.why.includes(why)) c.why.push(why);
      Object.assign(c, { year: c.year ?? extra.year, cover: c.cover ?? extra.cover, editions: Math.max(c.editions, extra.editions ?? 0) });
      map.set(key, c);
    };
    const fields = "title,author_name,cover_i,first_publish_year,edition_count,subject";
    const cov = (id?: number) => (id ? `https://covers.openlibrary.org/b/id/${id}-M.jpg` : undefined);
    await Promise.all([
      ...genres.map(async (g) => {
        const q = `subject:"${pretty(g)}" AND first_publish_year:[${since} TO 2026] AND language:eng`;
        const j = await ol(`https://openlibrary.org/search.json?q=${E(q)}&sort=editions&limit=40&fields=${fields}`);
        for (const d of j?.docs ?? []) {
          if (!wantsChildren && isKidsBook(d.subject)) continue;
          add(d.title, d.author_name?.[0], { year: d.first_publish_year, cover: cov(d.cover_i), editions: d.edition_count ?? 0 }, pretty(g), 1);
        }
      }),
      ...authors.map(async (a) => {
        const j = await ol(`https://openlibrary.org/search.json?author=${E(a)}&limit=10&sort=editions&fields=${fields}`);
        for (const d of j?.docs ?? []) add(d.title, d.author_name?.[0], { year: d.first_publish_year, cover: cov(d.cover_i), editions: d.edition_count ?? 0 }, `more by ${a}`, 3);
      }),
    ]);
    pool = [...map.values()].sort((a, b) => b.score - a.score || b.editions - a.editions).slice(0, 80);
    await sb.from("source_results").upsert({ query_norm: ckey, source: "recs", data: pool, fetched_at: new Date().toISOString() });
  }

  // Drop anything already read, borrowed, or on hold.
  const seenTitles = new Set(exclude.map((x) => tkey(x.title)));
  const fresh = pool.filter((c) => !seenTitles.has(tkey(c.title))).slice(0, 40);

  // Library availability, library-first (Libby + Multnomah print catalog).
  const checked = await Promise.all(fresh.map(async (c) => ({ ...c, libby: await libby(c.title, c.author), mcl: null as MclResult | null })));
  const needMcl = checked
    .filter((c) => c.libby?.status !== "borrow_now")
    .sort((a, b) => b.score - a.score || b.editions - a.editions)
    .slice(0, 16);
  await Promise.all(needMcl.map(async (c) => { c.mcl = await mclPrint(c.title, c.author); }));

  const rank = (c: { libby?: { status?: string } | null; mcl?: MclResult | null }) => {
    if (c.libby?.status === "borrow_now" || c.mcl?.status === "borrow_now") return 0;
    if (c.libby?.status === "hold" || c.mcl?.status === "hold") return 1;
    return 2;
  };
  const libbyPref = (c: { libby?: { status?: string } | null }) => (c.libby?.status === "borrow_now" ? 0 : 1);
  const sorted = checked.sort(
    (a, b) => rank(a) - rank(b) || b.score - a.score || libbyPref(a) - libbyPref(b) || b.editions - a.editions
  );

  // Variety: at most two books per author.
  const per = new Map<string, number>();
  const items: typeof sorted = [];
  for (const c of sorted) {
    const k = surname(c.author);
    if ((per.get(k) ?? 0) >= 2) continue;
    per.set(k, (per.get(k) ?? 0) + 1);
    items.push(c);
    if (items.length >= 14) break;
  }
  return out({ count: items.length, basedOn: { genres: genres.map(pretty), authors }, items });
});