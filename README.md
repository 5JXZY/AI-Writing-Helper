<img width="752" height="819" alt="屏幕截图 2026-05-11 152442" src="https://github.com/user-attachments/assets/69759f7f-2c10-479b-8fae-24724030506b" />
<img width="752" height="819" alt="屏幕截图 2026-05-11 152442" src="https://github.com/user-attachments/assets/ef60c92b-3e1a-4b1a-819c-618d91634d6f" />
# NovelForge

A local, privacy-first novel-writing workstation that turns your prompt set into a true source-of-truth for what gets sent to any OpenAI-compatible LLM.

[中文文档 / Chinese version →](./README.zh.md)

---

## Why NovelForge

Most novel-writing tools either lock you into a vendor's prompt template, or hide the actual bytes that go to the LLM. NovelForge does the opposite — every prompt-set entry is a **draggable, ordered message**, and the panel order **literally equals** the order delivered to the API. No surprises, no hidden glue.

It is offline by design (single-user Flask app on `localhost`), uses plain `.md` files for content (Git-friendly, manually editable), and supports any OpenAI-compatible chat endpoint (DeepSeek, Anthropic via proxies, OpenAI, local LLMs, etc.).

## Features

- **Visual prompt-set editor** — drag-reorder, toggle, rename, and inspect every system / user / assistant message before it leaves your machine.
- **Live-mirroring of the chat input** — the message you are still typing is rendered as an entry in the prompt panel, so the preview is *truly* what the model sees.
- **Atomic structure updates** — drag-reorder uses a build-and-swap pattern with a per-prompt-set lock; partial-write crashes recover automatically on next launch.
- **Built-in agent loop** — when the model emits `<<<READ:novel/vol/chap>>>`, `<<<FILE:filename>>>`, or `<<<ASK_AGENT:question>>>`, the server fetches and feeds the result back, up to 5 rounds. False-positive directives (e.g., the model echoing an example) are detected and skipped.
- **AI-editable prompt items** — let the model rewrite specific fields by closing its reply with `<<<UPDATE:title>>>...<<<END>>>`.
- **Stop button + keyboard niceties** — `Enter` sends, `Shift+Enter` newlines, IME composition is respected, mid-stream cancellation supported.
- **Sensible defaults** — every prompt set ships with built-in slots for current chapter, chapter catalog, file repository, chat history, and pending input — each individually toggleable.

## Quick start

### 1. Prerequisites
- Python 3.9+
- Modern browser (Chrome / Edge / Firefox)

### 2. Install
```bash
git clone https://github.com/<your-username>/NovelForge.git
cd NovelForge
pip install flask requests
```

### 3. Configure
Open `config.json` and replace `YOUR_API_KEY_HERE` with your real API key. Pick a preset (`active_preset`) or fill in the top-level `api_url` / `model` directly.

### 4. Run
```bash
python app.py
# or on Windows:
start.bat
```
Open `http://localhost:5000` in your browser.

## Architecture overview

```
NovelForge/
├── app.py                # Flask backend (~1000 lines)
├── config.json           # Runtime config (API endpoints, port, ...)
├── static/
│   ├── app.js            # Frontend logic (~1100 lines)
│   └── style.css
├── templates/
│   └── index.html        # Single-page UI
├── prompts/              # Prompt sets (user data, .gitignored)
│   └── _builtin/         # Read-only built-in resources
│       ├── read_hint.md
│       └── file_repo_intro.md
└── novels/               # Novel chapters (user data, .gitignored)
```

### Backend highlights

- **Mode dispatch table** (`MODE_HANDLERS`) — every prompt-item mode (fixed / ai_editable / chapter / catalog / context / read_hint / reference / latest_input / file_repo) is one entry away from extension. No giant if/elif chains.
- **Build-and-swap atomic writes** — `_build_and_swap_items` constructs `items_new/` then atomically `rename`s it into place, with a `_src_idx` matching strategy (precise) and a title fallback (defensive).
- **Per-prompt-set thread lock** — Flask's debug server is multi-threaded; `_ps_lock(name)` serializes structure / item / ai-update mutations on the same set, eliminating the classic "save races with reorder" data-loss bug.
- **Crash recovery on startup** — `_cleanup_prompt_set_residuals` scans for half-completed swaps (`items_new/` or `items_old/`) and fixes them.
- **Unified messages array** — `/api/chat` accepts a single ordered `messages` list; the frontend's `buildMessages` emits role-tagged entries that map 1:1 to the prompt-panel order.

### Prompt-item modes

| Mode | Has `.md` file | Content source |
|------|----------------|----------------|
| `fixed` | ✓ | User-edited markdown |
| `ai_editable` | ✓ | Same as `fixed`, plus model can rewrite via `<<<UPDATE:>>>` |
| `chapter` | — | Live editor textarea |
| `reference` | — | Selected chapters from the novel tree |
| `catalog` | — | Auto-generated novel index |
| `read_hint` | — | `prompts/_builtin/read_hint.md` |
| `file_repo` | — | `prompts/_builtin/file_repo_intro.md` + filesystem scan |
| `context` | — | Chat history (expanded by role) |
| `latest_input` | — | Live mirror of the chat input box |

### Agent directives the model can emit

| Directive | Effect |
|-----------|--------|
| `<<<READ:novel/vol/chap>>>` | Server reads `novels/<novel>/chapters/<vol>_<chap>.md` and feeds it back |
| `<<<FILE:filename>>>` | Server resolves the filename in the file repo (recursive search supported) |
| `<<<ASK_AGENT:question>>>` | Posts a message to `mailbox/inbox/`, polls `mailbox/outbox/` for the reply |
| `<<<UPDATE:title>>>...<<<END>>>` | Server overwrites the corresponding `ai_editable` item |

## Configuration

`config.json` fields:

| Field | Description |
|-------|-------------|
| `port` | HTTP port (default 5000) |
| `api_url` | LLM endpoint (must speak OpenAI-compatible chat protocol) |
| `api_key` | Bearer token sent in `Authorization` header |
| `model` | Model identifier (e.g. `deepseek-chat`, `gpt-4o`, `claude-sonnet-4-20250514`) |
| `default_system_prompt` | Optional fallback injected only when no `system` message is present |
| `file_repo_dir` | Path (absolute or relative to project) to your reference files folder |
| `active_preset` | Which preset name from `presets` to apply on startup |
| `presets` | Named bundles of `{api_url, api_key, model}` that you can swap between |

## Status

This is a living project — the feature roadmap (see `阶段 X` in commit history) progressively adds:
- Phase 3: FIRM mode (locked-baseline prompt items with explicit save)
- Phase 4: Per-item gear-icon drawer UI for fine-grained config
- Phase 5: Light-green "+ new prompt item" button + modal cleanup

Stable enough for daily writing use today.

## License

MIT — do whatever you want, no warranty.
