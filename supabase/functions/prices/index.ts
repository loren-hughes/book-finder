import { createClient } from "npm:@supabase/supabase-js@2";

const authOk = (k: string | null) => {
  const raw = Deno.env.get("APP_ACCESS_KEY") ?? "";
  const keys = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return !!k && keys.includes(k);
};
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const H = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const TTL = 6 * 3600 * 1000;
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });
const dec = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");
const text = (h: string) => dec(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const norm = (s?: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const num = (s: string) => Number(s.replace(/,/g, ""));
const surname = (a?: string) => { if (!a) return ""; const s = a.includes(",") ? a.split(",")[0] : a.trim().split(/\s+/).pop()!; return norm(s); };

async function get(u: string) {
  return await fetch(u, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(12000) });
}

async function amazon(title: string, author: string) {
  const q = `${title} ${author}`.trim();
  const search = `https://www.amazon.com/s?k=${encodeURIComponent(q)}&i=stripbooks`;
  const res = await get(search);
  const html = await res.text();
  if (res.status !== 200 || /captcha|Robot Check/i.test(html.slice(0, 5000))) throw new Error(`amazon blocked (${res.status})`);
  const re = /<div[^>]*data-asin="([A-Z0-9]{10})"[^>]*data-component-type="s-search-result"[^>]*>/g;
  const hits: { asin: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) hits.push({ asin: m[1], at: m.index });
  const want = norm(title), sn = surname(author);
  for (let i = 0; i < hits.length; i++) {
    const t = text(html.slice(hits[i].at, i + 1 < hits.length ? hits[i + 1].at : hits[i].at + 20000));
    const head = norm(t.slice(0, 400));
    if (!head.includes(want) || (sn && !head.includes(sn))) continue;
    const newPrices: Record<string, number> = {};
    for (const x of t.matchAll(/(Paperback|Hardcover|Kindle|Audio CD|Mass Market Paperback)\s+Price, product page\s+\$([\d,]+\.\d{2})/g)) newPrices[x[1]] = num(x[2]);
    const mb = t.match(/More Buying Choices\s+\$([\d,]+\.\d{2})\s+\((\d+\+?)\s+used & new offers\)/);
    if (!Object.keys(newPrices).length && !mb) continue;
    return { site: "Amazon", url: `https://www.amazon.com/dp/${hits[i].asin}`, usedFrom: mb ? num(mb[1]) : undefined, usedOffers: mb?.[2], newPrices };
  }
  return { site: "Amazon", url: search, none: true };
}

async function abebooks(title: string, author: string) {
  const search = `https://www.abebooks.com/servlet/SearchResults?tn=${encodeURIComponent(title)}${author ? `&an=${encodeURIComponent(author)}` : ""}&sortby=17&bi=0&ds=20`;
  const res = await get(search);
  const html = await res.text();
  if (res.status !== 200) throw new Error(`abebooks ${res.status}`);
  const want = norm(title), sn = surname(author);
  const parts = html.split(/data-test-id="listing-item-\d+"/).slice(1);
  const g = (seg: string, id: string) => { const m = seg.match(new RegExp(`data-test-id="${id}"[^>]*>([\\s\\S]*?)</`)); return m ? text(m[1]) : undefined; };
  const items: any[] = [];
  for (const seg of parts) {
    const t = g(seg, "listing-title"), a = g(seg, "listing-author");
    if (!t || !norm(t).includes(want)) continue;
    if (sn && !norm(a).includes(sn)) continue;
    const p = seg.match(/data-test-id="item-price-\d+"[\s\S]{0,400}?US\$\s*([\d,]+\.\d{2})/);
    if (!p) continue;
    const sh = seg.match(/data-test-id="item-shipping-price-\d+"[\s\S]{0,900}?(?:(Free Shipping)|US\$\s*([\d,]+\.\d{2}))/);
    const price = num(p[1]), ship = sh?.[2] ? num(sh[2]) : 0;
    const href = seg.match(/<a[^>]*data-test-id="listing-title-link"[^>]*>/)?.[0].match(/href="([^"]+)"/)?.[1];
    items.push({
      title: t, price, shipping: ship, total: Math.round((price + ship) * 100) / 100, condition: g(seg, "listing-condition"),
      seller: g(seg, "listing-seller-link"), url: href ? "https://www.abebooks.com" + dec(href) : search,
    });
  }
  const used = items.filter((x) => !/^new/i.test(x.condition ?? "")).sort((a, b) => a.total - b.total)[0];
  const any = [...items].sort((a, b) => a.total - b.total)[0];
  return { site: "AbeBooks", url: search, lowestUsed: used, lowestAny: any, matches: items.length };
}

async function cached(key: string, source: string, fn: () => Promise<any>) {
  const { data } = await sb.from("source_results").select("data,fetched_at").eq("query_norm", key).eq("source", source).maybeSingle();
  if (data && Date.now() - new Date(data.fetched_at).getTime() < TTL) return data.data;
  try {
    const r = await fn();
    await sb.from("source_results").upsert({ query_norm: key, source, data: r, fetched_at: new Date().toISOString() });
    return r;
  } catch (e) { if (data) return data.data; throw e; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: H });
  const url = new URL(req.url);
  if (!authOk(req.headers.get("x-app-key") ?? url.searchParams.get("k"))) return out({ error: "unauthorized" }, 401);
  const title = (url.searchParams.get("title") ?? "").trim();
  const author = (url.searchParams.get("author") ?? "").trim();
  if (!title) return out({ error: "title required" }, 400);
  const key = "p:" + norm(`${title} ${author}`);
  const errors: string[] = [];
  const run = (source: string, fn: () => Promise<any>) => cached(key, source, fn).catch((e) => { errors.push(`${source}: ${(e as Error).message}`); return null; });
  const [az, abe] = await Promise.all([run("price_amazon", () => amazon(title, author)), run("price_abebooks", () => abebooks(title, author))]);
  return out({ title, author, sites: [abe, az].filter(Boolean), errors });
});