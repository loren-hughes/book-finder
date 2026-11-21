const authOk = (k: string | null) => {
  const raw = Deno.env.get("APP_ACCESS_KEY") ?? "";
  const keys = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return !!k && keys.includes(k);
};

const H = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
const APP_URL = Deno.env.get("APP_URL") ?? "https://8jdy5vhpx47w.ample.run/";
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"];
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });

type BookRef = { title: string; author?: string };

function cleanB64(raw: string): { data: string; mime: string } {
  const m = raw.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (m) return { mime: m[1], data: m[2].replace(/\s+/g, "") };
  return { mime: "image/jpeg", data: raw.replace(/\s+/g, "") };
}

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

async function callGemini(apiKey: string, input: any[]) {
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
          input,
          response_mime_type: "application/json",
          response_format: {
            type: "object",
            properties: {
              books: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    author: { type: "string" },
                  },
                  required: ["title"],
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
      if (r.status === 429 || r.status === 503 || r.status === 404 || /high demand|unavailable|overloaded|not found/i.test(msg)) {
        continue;
      }
      throw new Error(msg);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      errs.push(`${model}: ${msg}`);
      if (/timed out|aborted|429|503|high demand|unavailable|overloaded/i.test(msg)) {
        continue;
      }
      throw e;
    }
  }
  throw new Error(errs.join(" | "));
}

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMG_BYTES = 5 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: H });
  const url = new URL(req.url);
  let k = req.headers.get("x-app-key") ?? url.searchParams.get("k");

  const ct = req.headers.get("content-type") ?? "";
  let images: { data: string; mime_type: string }[] = [];
  let textInput = "";

  if (ct.startsWith("image/")) {
    if (!authOk(k)) return out({ error: "unauthorized" }, 401);
    const mime = ct.split(";")[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(mime)) return out({ error: "unsupported image type" }, 400);
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.length > MAX_IMG_BYTES) return out({ error: "image too large (max 5 MB)" }, 413);
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    images.push({ data: btoa(bin), mime_type: mime });
  } else {
    const body = await req.json().catch(() => ({}));
    k = k ?? body.k ?? null;
    if (!authOk(k)) return out({ error: "unauthorized" }, 401);
    textInput = String(body.text ?? "").trim().slice(0, 2000);
    const rawList: any[] = Array.isArray(body.images) ? body.images : body.image ? [{ data: body.image, mime_type: body.mime_type }] : [];
    for (const item of rawList.slice(0, 6)) {
      const rawData = typeof item === "string" ? item : String(item?.data ?? "");
      if (!rawData) continue;
      if (rawData.length > MAX_IMG_BYTES * 1.4) return out({ error: "image too large (max 5 MB)" }, 413);
      const parsed = cleanB64(rawData);
      const mime = String(item?.mime_type || parsed.mime || "image/jpeg").toLowerCase();
      if (!ALLOWED_MIME.has(mime)) continue;
      images.push({ data: parsed.data, mime_type: mime });
    }
  }

  const apiKey = Deno.env.get("Gemini_API_Key") ?? Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return out({ error: "Gemini_API_Key secret is not set" }, 503);

  if (!images.length && !textInput) {
    return out({ error: "Provide at least one image or text", url: APP_URL }, 400);
  }

  const prompt = [
    "Extract every book mentioned or shown in the provided screenshot(s) or text (e.g., book covers, book spines, Instagram video text overlays, or reading lists).",
    "Ignore UI chrome, usernames, timestamps, hashtags, and unrelated comments.",
    "Return JSON with a `books` array of { title, author }. Leave `author` as empty string if not visible.",
    textInput ? `\nText:\n${textInput}` : "",
  ].join(" ");

  const input: any[] = [{ type: "text", text: prompt }];
  for (const img of images) {
    input.push({ type: "image", data: img.data, mime_type: img.mime_type });
  }

  try {
    const resp = await callGemini(apiKey, input);
    const rawText = extractText(resp);
    let parsed: { books?: BookRef[] } = {};
    try {
      parsed = JSON.parse(rawText);
    } catch (_) {
      const m = rawText.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    }

    const seen = new Set<string>();
    const books: BookRef[] = [];
    for (const b of parsed.books ?? []) {
      const title = String(b?.title ?? "").trim();
      const author = String(b?.author ?? "").trim();
      if (!title) continue;
      const key = `${title.toLowerCase()}|${author.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      books.push(author ? { title, author } : { title });
    }

    let appUrl = APP_URL;
    if (books.length === 1) {
      const q = `${books[0].title} ${books[0].author ?? ""}`.trim();
      appUrl = `${APP_URL}?q=${encodeURIComponent(q)}`;
    } else if (books.length > 1) {
      appUrl = `${APP_URL}?books=${encodeURIComponent(JSON.stringify(books))}`;
    }

    return out({ count: books.length, books, url: appUrl });
  } catch (e) {
    const err = String((e as Error).message ?? e);
    return out({ error: err, url: `${APP_URL}?scan_error=${encodeURIComponent(err)}` }, 502);
  }
});