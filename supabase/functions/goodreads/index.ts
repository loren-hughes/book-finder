import { createClient } from "npm:@supabase/supabase-js@2";

const authOk = (k: string | null) => {
  const raw = Deno.env.get("APP_ACCESS_KEY") ?? "";
  const keys = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return !!k && keys.includes(k);
};
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const H = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const TTL = 30 * 60 * 1000;
const SHELVES = ["read", "currently-reading", "to-read", "did-not-finish"];
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });
const dec = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
const tag = (item: string, name: string) => { const m = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? dec(m[1]) : ""; };
const norm = (s?: string) => (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const tkey = (s?: string) => norm(s).replace(/^(the|a|an) /, "");
const surname = (a?: string) => { if (!a) return ""; const s = a.includes(",") ? a.split(",")[0] : a.trim().split(/\s+/).pop()!; return norm(s); };
const sameBook = (a: { title?: string; author?: string }, b: { title?: string; author?: string }) => {
  const x = tkey(a.title), y = tkey(b.title);
  if (!x || !y) return false;
  if (x !== y && !x.startsWith(y) && !y.startsWith(x)) return false;
  const s1 = surname(a.author), s2 = surname(b.author);
  return !s1 || !s2 || s1 === s2;
};

async function fetchShelf(base: string, shelf: string) {
  const items: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const u = new URL(base);
    u.searchParams.set("shelf", shelf);
    u.searchParams.set("per_page", "200");
    u.searchParams.set("page", String(page));
    u.searchParams.set("sort", "date_read");
    const res = await fetch(u.toString(), { headers: { "User-Agent": "Mozilla/5.0 (compatible; BookFinder/1.0)" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`goodreads ${res.status}`);
    const xml = await res.text();
    const parts = xml.split("<item>").slice(1);
    for (const p of parts) {
      const raw = tag(p, "title");
      const series = raw.match(/\(([^)]*#\d+[^)]*)\)\s*$/)?.[1];
      items.push({
        id: tag(p, "book_id"),
        title: raw.replace(/\s*\([^)]*#\d+[^)]*\)\s*$/, "").trim(),
        series,
        author: tag(p, "author_name"),
        isbn: tag(p, "isbn") || undefined,
        rating: Number(tag(p, "user_rating")) || 0,
        readAt: tag(p, "user_read_at") || undefined,
        added: tag(p, "user_date_created") || undefined,
        shelves: tag(p, "user_shelves") || undefined,
        avg: Number(tag(p, "average_rating")) || undefined,
        pages: Number(tag(p, "num_pages")) || undefined,
        cover: tag(p, "book_medium_image_url") || tag(p, "book_image_url") || undefined,
        url: tag(p, "link") || undefined,
      });
    }
    if (parts.length < 200) break;
  }
  return items;
}

async function getStored(shelf: string): Promise<any[]> {
  const { data } = await sb.from("source_results").select("data").eq("query_norm", "goodreads").eq("source", shelf).maybeSingle();
  return Array.isArray(data?.data) ? data.data : [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: H });
  const url = new URL(req.url);
  if (!authOk(req.headers.get("x-app-key") ?? url.searchParams.get("k"))) return out({ error: "unauthorized" }, 401);

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const action = String(url.searchParams.get("action") ?? body.action ?? "import");
    const now = new Date().toISOString();

    if (action === "mark_read") {
      const title = String(body.title ?? "").trim();
      const author = String(body.author ?? "").trim();
      const rating = Number(body.rating) || 0;
      if (!title) return out({ error: "title required" }, 400);
      const readList = await getStored("read");
      if (!readList.some((b) => sameBook(b, { title, author }))) {
        readList.unshift({ id: "app_" + Date.now(), title, author, rating, readAt: now.slice(0, 10) });
        await sb.from("source_results").upsert({ query_norm: "goodreads", source: "read", data: readList, fetched_at: now });
      }
      for (const sh of ["to-read", "currently-reading"]) {
        const list = await getStored(sh);
        const next = list.filter((b) => !sameBook(b, { title, author }));
        if (next.length !== list.length) {
          await sb.from("source_results").upsert({ query_norm: "goodreads", source: sh, data: next, fetched_at: now });
        }
      }
      return out({ ok: true, count: readList.length });
    }

    if (action === "unmark_read") {
      const title = String(body.title ?? "").trim();
      const author = String(body.author ?? "").trim();
      if (!title) return out({ error: "title required" }, 400);
      const readList = await getStored("read");
      const next = readList.filter((b) => !sameBook(b, { title, author }));
      await sb.from("source_results").upsert({ query_norm: "goodreads", source: "read", data: next, fetched_at: now });
      return out({ ok: true, count: next.length });
    }

    if (action === "add_wtr") {
      const title = String(body.title ?? "").trim();
      const author = String(body.author ?? "").trim();
      if (!title) return out({ error: "title required" }, 400);
      const wtrList = await getStored("to-read");
      if (!wtrList.some((b) => sameBook(b, { title, author }))) {
        wtrList.unshift({
          id: "app_" + Date.now(),
          title,
          author,
          year: body.year || undefined,
          series: body.series || undefined,
          cover: body.cover || undefined,
          added: now.slice(0, 10),
        });
        await sb.from("source_results").upsert({ query_norm: "goodreads", source: "to-read", data: wtrList, fetched_at: now });
      }
      return out({ ok: true, count: wtrList.length });
    }

    if (action === "remove_wtr") {
      const title = String(body.title ?? "").trim();
      const author = String(body.author ?? "").trim();
      if (!title) return out({ error: "title required" }, 400);
      const wtrList = await getStored("to-read");
      const next = wtrList.filter((b) => !sameBook(b, { title, author }));
      await sb.from("source_results").upsert({ query_norm: "goodreads", source: "to-read", data: next, fetched_at: now });
      return out({ ok: true, count: next.length });
    }

    const shelf = String(body.shelf ?? url.searchParams.get("shelf") ?? "");
    if (!SHELVES.includes(shelf)) return out({ error: "bad shelf" }, 400);
    if (!Array.isArray(body.items)) return out({ error: "items array required" }, 400);
    const items = body.items.slice(0, 5000);
    const { error } = await sb.from("source_results").upsert({ query_norm: "goodreads", source: shelf, data: items, fetched_at: now });
    if (error) return out({ error: error.message }, 500);
    return out({ ok: true, shelf, count: items.length, fetchedAt: now });
  }

  const shelf = url.searchParams.get("shelf") ?? "read";
  if (!SHELVES.includes(shelf)) return out({ error: "bad shelf" }, 400);
  const refresh = url.searchParams.get("refresh");
  const base = Deno.env.get("GOODREADS_RSS_URL");

  const { data } = await sb.from("source_results").select("data,fetched_at").eq("query_norm", "goodreads").eq("source", shelf).maybeSingle();
  if (!base) {
    if (data) return out({ shelf, cached: true, imported: true, fetchedAt: data.fetched_at, count: data.data.length, items: data.data });
    return out({ error: "GOODREADS_RSS_URL secret is not set and no CSV import found" }, 503);
  }
  if (data && !refresh && Date.now() - new Date(data.fetched_at).getTime() < TTL) return out({ shelf, cached: true, fetchedAt: data.fetched_at, count: data.data.length, items: data.data });
  try {
    const items = await fetchShelf(base, shelf);
    const now = new Date().toISOString();
    await sb.from("source_results").upsert({ query_norm: "goodreads", source: shelf, data: items, fetched_at: now });
    return out({ shelf, cached: false, fetchedAt: now, count: items.length, items });
  } catch (e) {
    const safeMsg = String((e as Error).message).replace(/https?:\/\/\S+/gi, "[url]");
    if (data) return out({ shelf, cached: true, stale: true, fetchedAt: data.fetched_at, count: data.data.length, items: data.data, warning: safeMsg });
    return out({ error: safeMsg }, 502);
  }
});