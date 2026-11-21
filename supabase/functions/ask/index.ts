import { createClient } from "npm:@supabase/supabase-js@2";

const authOk = (k: string | null) => {
  const raw = Deno.env.get("APP_ACCESS_KEY") ?? "";
  const keys = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return !!k && keys.includes(k);
};

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const H = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const UA = "Mozilla/5.0 (compatible; BookFinder/1.0)";
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"];
const E = encodeURIComponent;
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });

const norm = (s?: string) => (s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const tkey = (s?: string) => norm(s).replace(/^(the|a|an) /, "");
const surname = (a?: string) => { if (!a) return ""; const s = a.includes(",") ? a.split(",")[0] : a.trim().split(/\s+/).pop()!; return norm(s); };

type MclResult = { status: "borrow_now" | "hold" | "none"; format?: string; holds?: number; url?: string };

function extractText(resp: any): string {
  if (typeof resp?.output_text === "string" && resp.output_text.trim()) return resp.output_text;
  const outputs = resp?.outputs ?? resp?.steps ?? [];
  for (let i = outputs.length - 1; i >= 0; i--) {
    const item = outputs[i];
    if (typeof item?.text === "string" && item.text.trim()) return item.text;
    const content = item?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (typeof c?.text === "string" && c.text.trim()) return c.text;
      }
    }
  }
  return "";
}

async function callGemini(apiKey: string, prompt: string) {
  const errs: string[] = [];
  for (const model of MODELS) {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
          "Api-Revision": "2026-05-20",
        },
        body: JSON.stringify({
          model,
          input: [{ type: "text", text: prompt }],
          response_mime_type: "application/json",
          response_format: {
            type: "object",
            properties: {
              note: { type: "string" },
              books: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    author: { type: "string" },
                    why: { type: "string" },
                  },
                  required: ["title", "author", "why"],
                },
              },
            },
            required: ["books"],
          },
        }),
        signal: AbortSignal.timeout(12000),
      });
      const resp = await r.json();
      if (r.ok) return resp;
      const msg = resp?.error?.message || `gemini ${r.status}`;
      errs.push(`${model}: ${msg}`);
      if (r.status === 429 || r.status === 503 || r.status === 404 || /high demand|unavailable|overloaded|not found/i.test(msg)) continue;
      throw new Error(msg);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      errs.push(`${model}: ${msg}`);
      if (/timed out|aborted|429|503|high demand|unavailable|overloaded/i.test(msg)) continue;
      throw e;
    }
  }
  throw new Error(errs.join(" | "));
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
    const u = `https://multcolib.bibliocommons.com/v2/search?query=${E((title + " " + author).trim())}&searchType=smart&locale=en-US&f_ISO_LANGUAGE=eng&f_FORMAT=BK`;
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: H });
  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const k = req.headers.get("x-app-key") ?? url.searchParams.get("k") ?? body.k ?? null;
  if (!authOk(k)) return out({ error: "unauthorized" }, 401);

  const apiKey = Deno.env.get("Gemini_API_Key") ?? Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return out({ error: "Gemini_API_Key secret is not set" }, 503);

  const userPrompt = String(url.searchParams.get("q") ?? body.prompt ?? "").trim().slice(0, 1000);
  if (!userPrompt) return out({ error: "Describe what kind of books you're looking for" }, 400);

  const exclude: { title: string; author?: string }[] = Array.isArray(body.exclude) ? body.exclude.slice(0, 800) : [];
  const { data: gr } = await sb.from("source_results").select("data").eq("query_norm", "goodreads").eq("source", "read").maybeSingle();
  const readList: { title?: string }[] = Array.isArray(gr?.data) ? gr.data : [];
  const seenTitles = new Set<string>([
    ...exclude.map((x) => tkey(x.title)),
    ...readList.map((x) => tkey(x.title)),
  ].filter(Boolean));

  const aiPrompt = [
    "You are a helpful librarian and book recommender.",
    "Recommend 8 to 10 real, well-regarded published books in English that specifically match the user's request.",
    "Only recommend real books with accurate titles and authors. Never invent titles.",
    "For each book, give a concise 1-sentence `why` explaining how it fits the request.",
    "Also provide a brief 1-sentence `note` summarizing your picks.",
    `\nUser request: ${userPrompt}`,
  ].join(" ");

  try {
    const resp = await callGemini(apiKey, aiPrompt);
    const rawText = extractText(resp);
    let parsed: { note?: string; books?: { title: string; author: string; why: string }[] } = {};
    try {
      parsed = JSON.parse(rawText);
    } catch (_) {
      const m = rawText.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    }

    const dedup = new Set<string>();
    const picks: { title: string; author: string; why: string[] }[] = [];
    for (const b of parsed.books ?? []) {
      const title = String(b?.title ?? "").trim();
      const author = String(b?.author ?? "").trim();
      const why = String(b?.why ?? "").trim();
      if (!title || seenTitles.has(tkey(title))) continue;
      const key = `${tkey(title)}|${surname(author)}`;
      if (dedup.has(key)) continue;
      dedup.add(key);
      picks.push({ title, author, why: why ? [why] : [] });
      if (picks.length >= 10) break;
    }

    const checked = await Promise.all(
      picks.map(async (c) => ({ ...c, libby: await libby(c.title, c.author), mcl: null as MclResult | null })),
    );
    const needMcl = checked.filter((c) => c.libby?.status !== "borrow_now").slice(0, 10);
    await Promise.all(needMcl.map(async (c) => { c.mcl = await mclPrint(c.title, c.author); }));

    const rank = (c: { libby?: { status?: string } | null; mcl?: MclResult | null }) => {
      if (c.libby?.status === "borrow_now" || c.mcl?.status === "borrow_now") return 0;
      if (c.libby?.status === "hold" || c.mcl?.status === "hold") return 1;
      return 2;
    };
    const items = checked.sort((a, b) => rank(a) - rank(b));

    return out({ prompt: userPrompt, note: String(parsed.note ?? "").trim(), count: items.length, items });
  } catch (e) {
    return out({ error: String((e as Error).message ?? e) }, 502);
  }
});