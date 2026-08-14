# The Fountain — Translation Dashboard

A Node.js dashboard that translates an EPUB to Persian (Farsi) with your local
Ollama models — pick a book, pick a model, press Start, and watch every request
stream in live: the sentence being translated, the Persian typing in as the model
generates, the timing of each call, the overall percentage, and a speed/ETA.

```
cd app
npm install
node server.js          # → http://localhost:8765
```

## What you can do from the UI

- **Choose a book** — drop `.epub` files into `app/books/`.
- **Choose a model** — every local Ollama model is listed with size/quantization.
- **Disable reasoning** — sends `think:false` for qwen3/deepseek-style models
  (dramatically faster; no reasoning tokens).
- **Translate any range** — whole book, or "only page 12", or pages 12–13
  (~250 words/page). Blank = whole book.
- **Choose the output format** — EPUB (native), Word `.docx` (built directly,
  RTL paragraphs), or PDF (rendered by headless Chrome with Noto Naskh Arabic,
  so Persian shapes correctly).
- **Watch it live** — a card appears the instant a request is sent, the Persian
  streams in as tokens arrive, then settles into clean English / Persian pairs
  with the duration of that call.
- **Progress + ETA** — percentage, words done/total, words/min, and a live ETA.
- **Versioned prompts** — ✎ opens the editor: create, edit, save, delete prompt
  presets (system prompt, rules, temperature, **paragraphs/request**, glossary
  top-N). Stored in `app/data/prompts.json`.
- **Persistent settings (in the range bar)** — **Concurrent** (how many requests
  run in parallel) and **Words/request** (bundle whole paragraphs until this many
  words; sentences are never split). Changed values save automatically to
  `app/data/settings.json` and survive restarts. The UI shows the recommended
  defaults (`rec.` badges): **Concurrent 2**, **Words/request 150**.
  - `Words/request = 1` → each paragraph is its own request; the model streams
    plain Persian straight into that paragraph's line (`loading…` until it types in).
  - `Words/request = 300–500` → the old batched behavior (paragraphs fill together).
  - `Concurrent = 2–8` → several requests in flight at once (faster, less calm).
- **Name glossary (persistent)** — **Names** opens an editor for the
  proper-noun → Persian map (e.g. `Janet → جَنِت`). Edit any value, add or remove
  names, or press **Auto-build** to extract the book's names and transliterate the
  missing ones. Saved to `app/data/glossary.json` — it survives restarts. Names you
  set yourself (marked ★) are always sent in every translation prompt; auto-built
  names fill the rest by frequency up to the prompt's top-N.
- **Stop / Resume** — Stop aborts the current request; the next Start (or the
  Resume banner) continues from where it left off.
- **Fix pass** — if the model botched any paragraph, a "Needs review" count
  appears; **Fix** re-translates exactly those into `<book>_fa_v2.epub`.
- **Reset book** — the footer's **reset book** wipes all book memory
  (translations in `app/work/`, the name glossary, request/issue logs, outputs,
  and saved job state) so you can start completely over. Global settings and
  prompt presets are kept.

## How it stays durable

- Every completed batch is written to `app/work/<model>__<chapter>.xhtml`.
  A power loss / machine restart loses at most the single in-flight request —
  the next run re-translates only paragraphs that are still English and reuses
  everything already done.
- `app/data/state.json` records job progress, so a restart shows a
  "Resume previous job" banner with the exact percent and last file.
- `app/data/requests.log` keeps two lines per Ollama call (request before send,
  response after, shared id, `duration_ms`), rolled at ~5MB.
- `app/data/issues.log` records every kept-English paragraph with the English
  source and the model's output — the input to the Fix pass.

## API (for scripting)

| Endpoint | Purpose |
|---|---|
| `GET /api/books` / `GET /api/models` | list books / Ollama models |
| `GET/POST/PUT/DELETE /api/prompts[/:id]` | prompt presets CRUD |
| `POST /api/translate/start` | `{book, model, promptId, think, fromPage?, toPage?, fromWord?, toWord?, format?}` · format = `epub` \| `docx` \| `pdf` |
| `POST /api/translate/stop` · `GET /api/translate/status` | control + status |
| `GET /api/log` · `GET /api/issues` | raw request log / issues |
| `POST /api/fix` | run the fix pass → `<book>_fa_v2.epub` |
| `GET /events` | SSE stream of `request/token/response/progress/done/…` |

## Files

- `server.js` — Express app + API + SSE.
- `lib/ollama.js` — model list + streaming chat (`format:json`, `think`).
- `lib/epub.js` — EPUB read/write with a byte-preserving XHTML extractor
  (placeholder tokens keep inline markup intact).
- `lib/translator.js` — the job engine: ranges, batching, recursive retry,
  chapter cache, progress/ETA.
- `lib/jobs.js` — single active job, abort, durable `state.json`.
- `lib/fixer.js` — the Fix pass.
- `lib/export.js` — DOCX (hand-built, no deps) and PDF (headless Chrome) output.
- `public/` — the dashboard (vanilla JS, no build step).

