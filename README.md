# The Book-Translate — EPUB translation dashboard

A self-hosted web dashboard that translates an EPUB book into **any language pair**
via a local **Ollama** model or **any OpenAI-compatible API** (OpenAI, DeepSeek,
Groq, OpenRouter, Together, Mistral, …). Pick a book, pick a model, pick a word
range — the app streams the translation live to the browser (source left, target
right, typing in as tokens arrive), shows progress / speed / ETA, and produces a
translated EPUB (optionally DOCX or PDF).

Everything runs on your own machine or server; nothing leaves it except the
requests to whichever LLM provider you configure.

---

## Quick start

Fastest path from nothing to a translated book:

```bash
npm install
node server.js            # dashboard at http://localhost:8765
```

Then translate either way:

- **In the browser** — open `http://localhost:8765`, pick a **book** (drop `.epub` files into
  `books/` first), a **model**, and a **prompt**, then press **Start**. The output lands in
  `out/`.
- **Headless — no browser** — `curl` the server (it must be running). Whole book:

  ```bash
  curl -s -X POST http://localhost:8765/api/translate/start \
    -H 'content-type: application/json' \
    -d '{"book":"Book.epub","model":"gemma4:e4b","promptId":"compact-v1","think":false,"format":"epub"}'
  ```

  The job keeps translating server-side after the command exits; check progress with
  `curl -s http://localhost:8765/api/translate/status`. See **Run it headlessly** below for the
  full list of options.

First-time setup (Ollama or an OpenAI-compatible API key, target-language fonts) and host/port
configuration are in **Prerequisites** and **Configure** below.

---

## Prerequisites

**Node.js ≥ 18** (Express 5 requires it) plus one LLM provider:

- **Ollama** (local, free, offline) — install it for your OS below, then pull a
  model, e.g. `ollama pull aya-expanse:8b`. The app lists every model you've pulled.
- **An OpenAI-compatible API key** — OpenAI, DeepSeek, Groq, OpenRouter, Together,
  Mistral, or Ollama's own `http://localhost:11434/v1` endpoint.

### Install by operating system

| Requirement | Windows | macOS | Linux (Debian/Ubuntu) |
|---|---|---|---|
| **Node.js ≥ 18** (check `node --version`) | [nodejs.org](https://nodejs.org) LTS installer, or `winget install OpenJS.NodeJS.LTS` | `brew install node`, or the [nodejs.org](https://nodejs.org) `.pkg` | `curl -fsSL https://deb.nodesource.com/setup_lts.x \| sudo -E bash - && sudo apt-get install -y nodejs` (or via [`nvm`](https://github.com/nvm-sh/nvm)) |
| **Ollama** | [OllamaSetup.exe](https://ollama.com/download/windows) from [ollama.com](https://ollama.com) | `brew install ollama`, or the [macOS app](https://ollama.com/download/mac) | `curl -fsSL https://ollama.com/install.sh \| sh` |
| **Translation model** | `ollama pull aya-expanse:8b` | `ollama pull aya-expanse:8b` | `ollama pull aya-expanse:8b` |
| **Git** (only to clone the repo) | `winget install Git.Git`, or [git-scm.com](https://git-scm.com) | `brew install git` | `sudo apt-get install git` |
| **Google Chrome** (only for PDF export) | installer from [google.com/chrome](https://www.google.com/chrome) | `brew install --cask google-chrome`, or the installer | `.deb` from [google.com/chrome](https://www.google.com/chrome) |

> Ollama runs as a background service after install, so the dashboard reaches it at
> `http://localhost:11434` with no extra steps. Verify Node with `node --version`
> (should print `v18.x` or later).
>
> On other Linux distros, replace the apt commands with your package manager
> (`sudo dnf install nodejs git` on Fedora, `sudo pacman -S nodejs git` on Arch);
> the Ollama installer script and `nvm` work across all of them.

**Optional:**

- **Fonts** for the target language (e.g. Noto Naskh Arabic for Persian). DOCX/EPUB
  work without them; Word/browser fonts fall back gracefully.

---

## Install & run

```bash
npm install
node server.js
```

Open `http://localhost:8765` (or the host/port you configure — see below).

The server reads its host/port from **⚙ Settings → Server** (`data/settings.json`).
Changes take effect on the next start. `PORT` and `HOST` environment variables
override the saved values at boot, which is the standard way to set this when
deploying (systemd, Docker, a remote VPS):

```bash
HOST=0.0.0.0 PORT=9000 node server.js   # bind all interfaces on port 9000
```

> Default host is `0.0.0.0`, which exposes the dashboard to your LAN. For a
> local-only setup, set the host to `127.0.0.1`.

---

## Configure (the ⚙ Settings panel)

Open the dashboard and click **⚙ Settings**. Everything here is persisted in
`data/settings.json` (gitignored — your API key stays local) and survives
restarts.

### Server
- **Host / Port** — where the dashboard binds. Applies on the next server start;
  `PORT`/`HOST` env vars override the saved values (a badge tells you when).

### LLM provider
- **Type** — `Ollama (local)` or `OpenAI-compatible`.
- **Base URL** — auto-filled when you switch provider. Common values:

  | Provider | Base URL |
  |---|---|
  | Ollama (local) | `http://localhost:11434` |
  | OpenAI | `https://api.openai.com/v1` |
  | DeepSeek | `https://api.deepseek.com/v1` |
  | Groq | `https://api.groq.com/openai/v1` |
  | OpenRouter | `https://openrouter.ai/api/v1` |
  | Together | `https://api.together.xyz/v1` |
  | Mistral | `https://api.mistral.ai/v1` |
  | Ollama's OpenAI endpoint | `http://localhost:11434/v1` |

- **API key** — only needed for OpenAI-compatible providers. Alternatively set the
  `LLM_API_KEY` environment variable; it takes precedence over the stored key, so
  the key never has to live in a file.
- **Test connection** — pings the provider and reports how many models it can see,
  before you save.

### Language
- **Source** and **Target** — from a curated list of ~30 languages. They must
  differ. The same pair is also shown as quick selects in the header range bar.

The **Concurrent** and **Words/request** knobs stay in the range bar (they're also
persisted). `Ollama`-only features (e.g. **Disable reasoning**) are hidden when a
non-Ollama provider is selected.

Other env overrides: `OLLAMA_HOST` / `LLM_BASE_URL` set the provider base URL at
startup, and `LLM_API_KEY` sets the key.

---

## Use it

1. Drop `.epub` files into `books/`.
2. Pick the **book**, **model**, and **prompt** in the header.
3. Set the **source → target** languages (default English → Persian).
4. Optionally restrict the range — "only page 12", or pages 12–13 (~250
   words/page). Blank = whole book.
5. Press **Start**. Every request appears as a card the moment it's sent, with the
   target text streaming in live, then settling into clean source / target pairs.
6. Choose the output **format**: EPUB (native), Word `.docx`, or PDF.

Output files land in `out/` as `<book>_<lang>.epub` (e.g. `Book_fa.epub` for
Persian, `Book_fr.epub` for French) and are linked in the stats bar.

---

## Run it headlessly (no browser)

The dashboard is just a viewer — once a job starts, the server keeps translating on
its own and writes the output to `out/`. You can start, monitor, and stop a
translation with a few `curl` calls against the running server (it must be up:
`node server.js`). Handy for scripting, or for kicking off a long run from a
terminal without touching the browser.

Start a whole-book translation (the saved `lastModel` / `lastPromptId` / `lastFormat`
from the Settings panel work as-is — just name the book):

```bash
curl -s -X POST http://localhost:8765/api/translate/start \
  -H 'content-type: application/json' \
  -d '{"book":"Book.epub","model":"gemma4:e4b","promptId":"compact-v1","think":false,"format":"epub","sourceLang":"en","targetLang":"fa"}'
```

- `book` — exact filename from `books/` (spaces and dots as-is).
- `think` — optional; `false` disables reasoning, `true` enables it (omitting it
  is the same as `false`).
- `format` — `epub` (default), `docx`, or `pdf`.
- No range fields = **whole book**. Restrict with either page numbers or a word range:
  - pages → add `"fromPage":12,"toPage":13` (≈250 words/page)
  - words → add `"fromWord":2100,"toWord":2160`

Check progress, stop a job, or list the exact book filenames:

```bash
curl -s http://localhost:8765/api/translate/status   # percent, current file, ETA, state
curl -s -X POST http://localhost:8765/api/translate/stop
curl -s http://localhost:8765/api/books              # exact book filenames
```

Notes:

- **One job at a time** — if a translation is already running, `start` returns
  `409 {"error":"a translation is already running"}`. Stop it first, or just open
  the dashboard afterward to watch that job's progress live (it streams to the
  browser automatically).
- **Fire-and-forget** — the `start` POST returns immediately and the job keeps
  translating server-side after the command exits. Kill the `curl` and the job
  carries on.
- The server's other endpoints work the same way — see the REST API list below
  (e.g. `POST /api/fix` to re-translate flagged paragraphs).

---

## Durability & resume

A stopped job resumes from where it left off — even across machine restarts.

- After every completed request the translated chapter is written to
  `work/<model>__<targetLang>__<chapter>.xhtml`. On the next run, blocks marked
  `data-t="1"` (already translated) are reused as-is. The marker makes resume exact
  even for **same-script pairs** (e.g. English→French) where a script heuristic
  can't tell source from target.
- `data/state.json` records the job, and the resume banner in the UI restores
  the book/model/language/range for you.
- Switching the model or target language re-translates (the cache key includes
  both). After upgrading from an older version, the first run re-translates from
  scratch because old cache keys no longer match — that's expected.

## After Ctrl+C → npm start (resume, logs, review)

Stopping the server (Ctrl+C) loses nothing — every run's data lives on disk and the
dashboard picks it back up on the next `npm start`.

1. **Resume** — the banner shows the paused job's % and settings; **Resume** continues
   from the last saved batch (the chapter cache reuses `data-t="1"` blocks, so it
   resumes exactly where it left off).
2. **Open in Review** — the same banner has an **Open in Review** button: loads that
   book's saved translation cards as editable cards with **zero model calls** — no
   resume required.
3. **Request log** (footer → **request log**) — every model call as a searchable,
   filterable table: time, model, file, phase (request / response / error), duration,
   snippet. Toggle **Raw** for the underlying JSONL
   (`data/logs/<slug>/requests.jsonl`). New calls append live while the panel is open.
4. **Server log** (footer → **Server log**) — the server's own stdout/stderr
   (`data/logs/server.log`, capped at 2 MB) kept across restarts; auto-refreshes while
   open.
5. **Edit** — on any card (live or replayed): **✎ Edit** → edit the target inline →
   **Save**, or **↻ Re-translate** with another model. Changes are written back to the
   work cache and the output book is rebuilt automatically.

## The glossary (proper names)

The **Names** panel holds a persistent source-name → target-form map. Names you add
yourself (★) are always included in the prompt; **Auto-build** extracts capitalized
proper nouns from the book and transliterates the missing ones with one model call,
then keeps them consistent across every request. Auto-build needs a cased script
(Latin, Cyrillic); for case-less scripts (Arabic, Hebrew, CJK, …) add names
manually.

---

## Architecture

```
Browser (vanilla JS SPA, public/)
   │  EventSource /events (SSE)
   ▼
server.js  (Express: static, REST API, SSE hub, host/port from settings)
   │
   ├── lib/providers.js      → provider factory (ollama | openai-compatible)
   │   ├── lib/providers/ollama.js   (native /api/tags + /api/chat, NDJSON)
   │   └── lib/providers/openai.js   (OpenAI-compatible /v1, SSE streaming)
   ├── lib/languages.js      → ~30-language registry + script detection + fonts
   ├── lib/translator.js     → the job engine (scan → glossary → translate → export)
   ├── lib/epub.js           → read EPUB, extract translatable XHTML, rebuild EPUB
   ├── lib/jobs.js           → single active job, AbortController, durable state.json
   ├── lib/prompts.js        → versioned prompt presets (data/prompts.json)
   ├── lib/glossary.js       → persistent name → form map (data/glossary.json)
   ├── lib/settings.js       → persistent settings (data/settings.json)
   ├── lib/logger.js         → rolling JSONL logs (requests.log, issues.log)
   ├── lib/sse.js            → SSE client registry + broadcast
   ├── lib/fixer.js          → re-translate "kept source" paragraphs → _v2.epub
   └── lib/export.js         → DOCX (hand-built zip) + PDF (headless Chrome)
```

Design notes:

- **One paragraph per request is the default.** A paragraph is 1–3 sentences — the
  chunk you can follow — and plain-text streaming makes the translation type in
  live in that paragraph's line. Multi-paragraph batching (`Words/request ≥ 300`)
  is opt-in; those fill together as JSON.
- **Inline markup stays intact.** Before translating, inline elements (`<i>`, `<a>`,
  page-break spans) are replaced with placeholder tokens (`⟦s0⟧`, `⟦e0⟧`, `⟦1⟧`).
  The model must keep them in the translation; they're swapped back to raw markup
  afterwards. A dropped token is logged to the issues log for the Fix pass.
- **No Python, no build step.** Vanilla JS + 3 dependencies (`express`, `yauzl`,
  `yazl`). `npm install && node server.js` is all it takes.

---

## REST API (all JSON unless noted)

- `GET /api/books` · `GET /api/models` (from the configured provider) ·
  `GET /api/languages`
- `POST /api/providers/test` `{provider, baseUrl, apiKey}` — test a connection
  without saving
- `GET|POST|PUT|DELETE /api/prompts[/:id]`
- `GET /api/glossary` · `POST /api/glossary {src,tgt}` · `PUT/DELETE /api/glossary/:src` ·
  `POST /api/glossary/autobuild`
- `GET /api/settings` (includes `effective` config + env badges) ·
  `PUT /api/settings` (provider, baseUrl, apiKey, host, port, sourceLang, targetLang,
  concurrency, wordsPerRequest)
- `POST /api/translate/start` `{book, model, promptId, think, fromPage/toPage or
  fromWord/toWord, format, sourceLang?, targetLang?}` ·
  `POST /api/translate/stop` · `GET /api/translate/status`
- `GET /api/server-log` (server stdout/stderr tail) · `GET /api/log` (raw requests.log) ·
  `GET /api/issues` · `POST /api/issues/clear` · `POST /api/fix`
- `POST /api/reset` (wipe translations, glossary, logs, outputs, state; keeps
  settings/prompts)
- `GET /events` (SSE) · `GET /api/out` · `GET /api/out/:name`

---

## Troubleshooting

- **"provider offline"** — the app can't reach the provider. Check the base URL
  and (for OpenAI-compatible) the API key in ⚙ Settings, then **Test connection**.
  For Ollama, make sure the Ollama server is running (`ollama serve`).
- **HTTP 400 mentioning `response_format`** on an OpenAI-compatible provider — some
  providers reject structured JSON output. The app retries without it, but tell
  your provider you need JSON mode if batches keep failing.
- **Same-script pair (e.g. English→French)** — resume works via the `data-t`
  markers; you don't need to do anything.
- **Host/port won't change** — a `PORT`/`HOST` env var is overriding the saved
  values (the settings panel shows a badge). Restart with those unset to use the
  panel values.
- **PDF export fails** — Chrome isn't installed, or the target script's font isn't
  present. Install Chrome; EPUB/DOCX still work without it.
- **First run after an upgrade re-translates everything** — the cache key now
  includes the target language, so old `work/` files are ignored. Expected once.

---

## Development notes

Backend/flow test:

```bash
POST /api/issues/clear
rm -f work/*.xhtml
# POST /api/translate/start with a small range, e.g. {book, model, promptId, fromWord: 2250, toWord: 2450}
# Inspect data/requests.log: every request should have a request + response phase.
```

Streaming: `curl -s -N http://localhost:8765/events` shows `token` deltas of plain
target-language text. Output: `unzip -t out/*.epub`; verify `lang="<target>"`
and (for RTL targets) `dir="rtl"` on `<html>`.

Do not run long test translations on a live dashboard the user is driving — stop
the job before testing.
