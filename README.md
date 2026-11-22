# 📚 Book Finder

A **library-first** book discovery, availability, and hold-management web app built for **Multnomah County Library** (and adaptable to any library using **BiblioCommons + OverDrive/Libby**).

## Features

- **Unified Library-First Search (`search`)**: Search once by title, author (with typo tolerance for both titles and authors), or ISBN across Multnomah print/CD, Libby (ebook/audiobook/magazine), Spotify audiobooks, and live used prices (AbeBooks & Amazon — shown only when nothing is borrowable). Excludes non-English editions and already-read books (with an option to show anyway).
- **Screenshot Scanner (`scan`)**: Upload, paste (`Cmd+V`), or drag-and-drop screenshots from Apple Photos / Instagram book videos to extract every book title & author using Gemini Vision and check availability for all of them.
- **AI Book Assistant (`ask`)**: Describe what you're looking for in plain English (e.g., *"mixed media mosaic tile making"* or *"kids books with dragons"*) and get 8–10 real book picks ranked by live Multnomah + Libby availability.
- **Personalized Recommendations (`recs`)**: Generates picks from your 4–5★ Goodreads books, library holds, background saved searches, and checkouts (with an **Exclude checkouts** toggle), checked against both Libby and Multnomah print.
- **My Library (`library`)**: Syncs your checkouts and holds (with **Book / Ebook / Audiobook** labels and estimated hold wait times), lets you **Place**, **Suspend/Resume**, and **Cancel** print & digital holds with a **Pickup branch** selector, **Renew** checkouts, **Return** digital checkouts early, and toggle magazine issues.
- **For Later (Library) (`library`)**: Syncs your full Multnomah County Library *For Later* shelf (paginated past 50 items) with live availability status and copy/hold counts, one-tap **Place hold** for print items, **Formats** lookup (Libby, Spotify, used prices), **ⓘ** descriptions, and **×** remove.
- **Goodreads Lists (`goodreads`)**: Supports Goodreads RSS feeds or CSV import (`read`, `to-read`, `currently-reading`), with a **Want to Read** tab (full multi-source availability check per book) and an in-app **Read** list (`✓ Read` / `×`).
- **Spotify Audiobooks (`spotify`)**: Optional OAuth flow to save audiobooks directly to your Spotify library.

---

## Fork & Self-Host Setup

### 1. Create a Supabase Project
1. Create a new project at [supabase.com](https://supabase.com).
2. Open the **SQL Editor** and run [`supabase/schema.sql`](supabase/schema.sql) to create `saved_items`, `source_results`, and `hold_log`.

### 2. Deploy the Edge Functions
Using the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy --use-api
```

[`supabase/config.toml`](supabase/config.toml) sets `verify_jwt = false` for all 8 functions because they authenticate requests using `APP_ACCESS_KEY`.

### 3. Add Supabase Edge Function Secrets
In **Supabase Dashboard → Edge Functions → Secrets** (or `supabase secrets set`), add:

| Secret | Required? | Purpose |
| --- | --- | --- |
| `APP_ACCESS_KEY` | **Yes** | Comma-separated access key(s) for logging into your app (e.g. one per device) |
| `LIBRARY_CARD_NUMBER` | **Yes** | Your library card number for BiblioCommons sync & holds |
| `LIBRARY_PIN` | **Yes** | Your library PIN |
| `GEMINI_API_KEY` | Optional | Enables **📷 Screenshot Scanner** (`scan`) and **Ask Book Assistant** (`ask`) |
| `GOODREADS_RSS_URL` | Optional | Private Goodreads RSS link (or import your Goodreads CSV via `POST /goodreads`) |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Optional | Spotify Developer App credentials for audiobook search & `+ Save` |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | Optional | eBay Developer App credentials for live used book prices via eBay Browse API |
| `APP_URL` | Optional | Your hosted frontend URL (used by Spotify OAuth & `scan` redirects) |

### 4. Configure & Host the Frontend
1. Open [`index.html`](index.html) and update `BASE` to your Supabase project URL:
   ```js
   var BASE="https://YOUR_PROJECT_REF.supabase.co/functions/v1/";
   ```
2. If you use a different BiblioCommons/OverDrive library than Multnomah County Library (`multcolib`), update `multcolib` in `supabase/functions/*` and the `BRANCHES` list in `index.html`.
3. Host `index.html` on any static host (Ample Computer, Netlify, Cloudflare Pages, GitHub Pages, etc.).
   - *(Note: `goodreads_library_export.csv` and `.ample/` are ignored via `.gitignore` so personal data is never committed.)*