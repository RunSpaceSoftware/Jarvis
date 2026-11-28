# JARVIS

A local, always-on AI harness with a command-console interface, real tools, long-term memory, autonomous missions, timed reminders, MCP servers, and a Telegram bridge. Zero npm dependencies — it runs on Node 24+ (22.5+ may need `--experimental-sqlite`) with native `fetch`, `WebSocket`, and `node:sqlite`.

```
  http://127.0.0.1:8787
```

## 1. Start it

```powershell
cd D:\Projects\Jarvis
node server/index.mjs
```

or double-click `start.cmd`. The console prints a **sign-in link** (`http://127.0.0.1:8787/?token=…`). Open it once per browser; it stores a session cookie and redirects to the console. The token lives in `data/api_token.txt` if you ever need it again. Without it the API and UI return 401.

For the British neural voice (`en-GB-RyanNeural`), install the optional TTS dependency:

```powershell
pip install edge-tts
```

Without it, spoken replies fall back to the browser’s installed voices.

Put your model API key in **`secrets/model_key.txt`** (one line, no quotes), or paste it in **Settings → API Key**. The key never goes to the browser after saving; the UI only shows a `stored/missing` flag.

Before real work, open **Settings → Sandbox** and choose the folder Jarvis may use. Default is `workspace/` next to the project; point it at a dedicated folder if you want stronger separation, and add only the commands you trust.

Default model is `gpt-4o-mini` at `https://api.openai.com/v1`. Any OpenAI-compatible endpoint works — OpenRouter, DeepSeek, Groq, Together, a local Ollama (`http://localhost:11434/v1`), LM Studio, vLLM. Local endpoints do not need a key. Change base URL and model in Settings or `config/config.json`.

## 2. Talk to it

- Type in the console; **Enter** sends, **Shift+Enter** adds a line.
- **You can interrupt it while it is working.** Send a message; if Jarvis is mid-turn it is queued and injected before its next model step, so it sees your correction and adjusts without losing the work already done. A shell command that is already running must finish or time out first.
- **Stop** aborts the current turn without killing the server. In Telegram, `/stop` does the same.
- Each browser tab has threads; the selector in the top bar switches between them.
- `JARVIS.md` in the project root is injected every turn — put standing rules and facts about you there.

## 3. Missions (work while you sleep)

A mission is a persistent goal. With **Autopilot** on (default), Jarvis wakes every `autonomyIntervalSec` (180s), loads the mission and its notes, uses tools, records progress, and goes back to sleep. Missions pause after `maxGoalRuns` wake-ups or three failed runs in a row.

- Deploy from **Missions** or just ask in chat (the agent has `goal_create`).
- Progress and notes appear in the HUD, Missions view, and Telegram.
- Pause / resume / complete / delete from the mission card.
- Wake-ups are serialized with chat: it will not run a mission while answering you, and steering messages are processed first.

### Reminders

Ask naturally: **“Remind me in 30 minutes to stretch”** or **“Every day at 8, remind me to check the deploy.”**

- One-off and recurring reminders appear under **Missions → Reminders**; cancel them there or ask Jarvis. Recurrence is a fixed interval (daily = 24h), not a weekday/calendar rule.
- When one fires, it shows in the HUD, is spoken if **Spoken replies** is on, and is sent to Telegram if the bridge is connected.
- They are notifications, not model turns: they do not consume tokens or start work. Use a mission when you want Jarvis to do something.

## 4. Telegram bridge

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Paste it in **Settings → Telegram** (or write `secrets/telegram_token.txt`) and enable the bridge.
3. The Settings panel shows a pairing code (8 digits, single use, valid for 15 minutes). On your phone send `/pair <code>` to the bot in a private chat.
4. Talk to Jarvis by message. Replies to your last message are steering; `/stop` stops the current turn.

Commands: `/pair <code>`, `/status`, `/goals`, `/goal <text>`, `/reminders`, `/pause`, `/resume`, `/stop`, `/approvals`, `/approve <id>`, `/deny <id>`, `/new`, `/help`.

You can send images and documents to the bot. Files up to 20 MB are saved under `telegram-inbox/` in the configured workspace. Images go to `see_image`; PDF, DOCX, XLSX, PPTX, CSV and text files go to `read_document`. Unsupported types are refused with a reply. Telegram voice messages from you are still ignored.

Jarvis can send a workspace file back with `send_telegram_file`. JPEG, PNG and WebP images up to 10 MB are sent as photos; other files, or larger images, are sent as documents up to 50 MB. It only does this when you ask.

Every `telegram.updateMinutes` (default 3) Jarvis posts a short progress note while a mission is active. Replies to your messages stay text-only. If `voiceReplies` is on, Jarvis attaches one voice note to a periodic update, no more often than `updateMinutes`, using `edge-tts` with the British `en-GB-RyanNeural` voice:

```powershell
pip install edge-tts
```

Telegram bots cannot place real phone calls. Voice notes are the honest equivalent; Discord is not wired up yet (the token slot exists).

## 5. Voice

Speech recognition uses the browser’s Web Speech API — use Chrome or Edge and allow the microphone. Spoken replies use `edge-tts` neural voices when it is installed, with the browser voice as fallback.

- **Mic** = push to talk. Speech is transcribed and sent as a normal message.
- **Wake word** = continuous listening in that tab. Say “Jarvis, …” or “Jarvis” then your command. The tab must stay open; audio is handled by the browser engine.
- **Spoken replies** reads answers aloud (markdown and code stripped). Toggle any time.
- **Spoken voice** is selectable in Settings, with a test button. `Auto` tries the British `en-GB-RyanNeural` voice first, then the best installed browser voice. You can also pick Sonia, Libby, Guy, Andrew, or Aria.
- Neural playback needs `pip install edge-tts` and an internet connection. Audio is streamed to the browser as it is generated, so it starts before the full clip is ready. If synthesis fails, `Auto` falls back to the browser voice; an explicitly selected neural voice stays silent and shows an error instead of switching to Mark.
- Wake word, voice, and default speaking are configurable in Settings.

## 6. Tools

| Tool | What it does |
| --- | --- |
| `shell` | Runs an allowlisted program inside the workspace; no shell, timeout and abort support |
| `read_file` / `write_file` / `edit_file` / `list_files` / `grep` | Workspace file work |
| `web_fetch` | Fetch a URL and extract readable text |
| `web_search` | DuckDuckGo search results |
| `remember` / `recall` | Long-term memory |
| `goal_create` / `goal_list` / `goal_update` | Missions |
| `remind` / `reminder_list` / `reminder_cancel` | Timed and recurring reminders |
| `list_skills` / `use_skill` | Load a skill's full instructions |
| `browser` | Open a real Chrome/Edge window, snapshot, click, type, screenshot |
| `google` | Gmail list/read/send and Google Calendar list/create |
| `read_document` | Extract text from PDF, DOCX, XLSX, PPTX, CSV and text files |
| `see_image` | Analyze screenshots and photos with the configured vision model |
| `git` | Read-only status, diff, log and show |
| `github` | GitHub REST API with a token |
| `http_request` | Allowlisted HTTP calls and outbound webhooks |
| `send_telegram` | Message you from a mission |
| `send_telegram_file` | Send a workspace image or document to the paired Telegram chat |
| `mcp__<server>__<tool>` | Any connected MCP tool |

File tools are restricted to the configured workspace. Shell commands are disabled until you add program names to the allowlist in **Settings → Sandbox**.

### Integrations

**Browser.** Jarvis finds Chrome or Edge automatically; set `integrations.browser.path` if it does not. It launches a separate profile under `data/browser-profile`, outside the workspace, so it does not touch your normal browser session and file tools cannot read its cookies. Use `browser` actions `open`, `snapshot`, `click`, `type`, `screenshot`, `close`. Refs come from the latest snapshot. Treat it as a real browser: do not enter passwords or pay without confirmation.

**Google Gmail + Calendar.** One-time setup:

1. In Google Cloud Console, enable **Gmail API** and **Google Calendar API**.
2. Create an OAuth client of type **Desktop app**, download the JSON, and save it as `secrets/google_client.json`. While the app is in Testing, add your Google account as a test user.
3. Run `npm run google-auth`, open the printed URL, and approve access. The refresh token is saved to `secrets/google_token.json`.

`google` actions: `status`, `email_list`, `email_read`, `email_send`, `calendar_list`, `calendar_create`. Sending email and creating events pause for your approval (see section 11).

**GitHub.** Save a fine-grained token in `secrets/github_token.txt`. The `github` tool takes `method`, `path` (for example `/repos/owner/repo/issues`), and optional `body`. Anything other than GET waits for your approval (see section 11).

**HTTP/webhooks.** Add allowed hostnames to `config/config.json`:

```json
"integrations": { "http": { "allowedHosts": ["api.example.com", "*.example.com"] } }
```

Use `http_request` for outbound calls. For a bearer token, save it as `secrets/http_<name>.txt` and call with `auth: "<name>"`; the secret is never returned to the model.

**Documents and images.** `read_document` handles DOCX, XLSX, PPTX, CSV, Markdown, HTML and text directly. PDF text extraction uses the built-in fallback; install `pypdf` for better results: `pip install pypdf`. `see_image` sends the image to your configured model, so use a vision-capable model for screenshots and photos.

## 7. MCP servers

Add servers in **MCP** or edit `config/config.json`:

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "enabled": true },
    "remote": { "url": "https://example.com/mcp", "headers": {}, "enabled": true }
  }
}
```

Stdio servers are newline-delimited JSON-RPC child processes; HTTP servers use streamable HTTP with session IDs. Tools are exposed as `mcp__name__tool` and appear in the agent's tool list automatically. Use **restart** after changing a server's config.

## 8. Skills

Create `skills/<name>/SKILL.md`:

```markdown
---
name: writing
description: Long-form writing and editing with a clear voice.
---

Steps, rules, examples…
```

Jarvis sees the index every turn and calls `use_skill` to load the body when relevant. Press **Reload skills** after adding one. Two examples are included (`research`, `coding`).

## 9. Memory and context

- Conversations live in SQLite (`data/jarvis.db`).
- When history exceeds `model.compactAfter` messages, Jarvis summarizes older turns and keeps the summary plus recent messages; the token guard trims if needed.
- `remember` stores durable facts, preferences, decisions, and research notes. Relevant memories are retrieved by keyword every turn.
- Use the **Memory** tab to add, search, and forget entries.
- `JARVIS.md` is for stable instructions; memory is for learned facts.

## 10. Configuration

`config/config.json` is created on first boot and edited from Settings. Important fields:

```json
{
  "model": { "baseUrl": "…", "model": "…", "temperature": 0.6, "maxTokens": 4096, "contextMessages": 40, "compactAfter": 60 },
  "agent": { "autopilot": true, "autonomyIntervalSec": 180, "maxStepsPerTurn": 30, "maxGoalRuns": 200 },
  "telegram": { "enabled": false, "updateMinutes": 3, "voiceReplies": false },
  "voice": { "wakeWord": "jarvis", "autoSpeak": false, "name": "" },
  "integrations": {
    "browser": { "path": "", "headless": false, "port": 9222 },
    "http": { "allowedHosts": ["api.example.com"] }
  },
  "safety": {
    "workspace": "D:\\JarvisWork",
    "allowShell": true,
    "allowedCommands": ["node", "npm", "git"],
    "blockSecrets": true
  }
}
```

## 11. Sandbox, permissions & security

**Workspace jail.** Set **Settings → Sandbox → Workspace folder** to the folder Jarvis may use (absolute path is best). File tools resolve every read, write, edit, list and grep inside that folder, including all subfolders. Paths outside it are refused, symlink/junction escapes are checked against the real path, and the project's `secrets/` folder is always blocked. The folder is created if missing. Jarvis can do anything it wants inside it.

**Command allowlist.** Shell starts with no allowed programs. Add names in **Settings → Sandbox → Allowed commands**, one per line:

```text
node
npm
npx
git
python
```

Only the first program name is checked; arguments are passed literally. Commands run **without a shell**, so pipes (`|`), redirection (`>`), `&&`, `$variables`, globbing and built-ins like `cd`/`dir` are not interpreted. That removes a large class of injection bugs, but it also means compound commands must become separate tool calls. Child processes get a cleaned environment: API keys, tokens, and other `JARVIS_*`/secret variables are not passed to them. The working directory is always the workspace.

**Honest boundary.** This is an application-level sandbox, not a Windows security boundary. A program you allow (Node, Python, Git, a compiler) can still read absolute paths outside the workspace, and the model can write code that does so. The allowlist controls *which programs start*, not everything those programs do. For untrusted code, run Jarvis inside a Windows Sandbox, a VM, or under a dedicated Windows account whose ACLs only grant the workspace, and point the workspace there. Only allow programs you trust; a permissive allowlist (especially `cmd`, `powershell`, `node`, or `python`) is effectively full host access.

**Other protections.** The server binds `127.0.0.1` only; do not expose it without authentication. Secrets are read from `secrets/*.txt` and the API returns booleans, never values. MCP servers are separate processes outside this jail and get whatever access you give them. Reviewed code executes with your Windows user's permissions — treat missions like background scripts.

**API lockdown.** Any website you visit can make your browser send requests to `127.0.0.1`, so being bound to localhost is not enough. Every request must carry a `Host` of `127.0.0.1`, `localhost` or `[::1]` plus the port (add other names to `server.allowedHosts`), must not be cross-site (`Origin` / `Sec-Fetch-Site`), must send `application/json` for bodies, and must present the session token. The token is generated once, printed as the sign-in link, and kept in an HttpOnly, SameSite=Strict cookie; scripts can send `Authorization: Bearer <token>` or `X-Jarvis-Token`. Only `/api/health` is open. Responses carry a Content-Security-Policy, `nosniff` and no-framing headers. MCP servers added through the API must use a bare program name that is on the command allowlist, and API config changes can no longer set the paired Telegram chat or unknown safety keys.

**Approvals.** Sending email, creating calendar events, GitHub writes and non-GET `http_request` calls pause until you approve them. The prompt shows the exact action built from the tool arguments, in the interface and on Telegram (`/approve <id>`, `/deny <id>`). A `confirm=true` from the model is ignored. Unanswered requests are denied after `agent.approvalTimeoutSec` (default 300), and Stop denies them immediately. Set `safety.approveShell` to `true` to gate every shell command as well. Setting `safety.requireApproval` to `false` goes back to model-only confirmation, which is not recommended.

**Outbound requests.** `web_fetch` refuses loopback, private, link-local and cloud-metadata addresses, validates every redirect hop, checks the address at connect time (so DNS rebinding cannot swap it afterwards) and caps response size. The `browser` tool refuses local and private targets unless `integrations.browser.allowLocal` is `true` (needed to test a dev server). Output from web, email, document, GitHub, HTTP and MCP tools is fenced as untrusted data before the model sees it. That lowers prompt-injection risk but cannot remove it, which is why approvals exist.

**Telegram pairing.** Codes are 8 digits from a cryptographic RNG, single use, and expire after 15 minutes. Five wrong guesses lock pairing for 15 minutes. Pairing only works in a private chat with the bot. Once paired, only the Telegram user who paired can give commands; anything else is ignored and logged in the activity feed, never dropped silently. A chat paired before this change (including a group) keeps working, with a warning that anyone in a group can command Jarvis until you re-pair privately.

**Tests.** `npm test` runs the security tests (SSRF guard, origin/token checks, approvals, config merge).

## 12. Autostart on Windows

Task Scheduler → Create Task → Trigger *At log on* → Action *Start a program* → `D:\Projects\Jarvis\start.cmd`. Set *Start in* to `D:\Projects\Jarvis`. The console window can be minimized; use **Hidden** in Task Scheduler if you prefer. If the window is hidden, read the sign-in token from `data/api_token.txt` and open `http://127.0.0.1:8787/?token=<token>` once per browser.

## 13. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `No model API key` | Put the key in `secrets/model_key.txt` or Settings; local base URLs skip the key. |
| 401/404 from model | Check base URL ends in `/v1`, model name, and key. |
| Telegram `off` | Token missing; save it in Settings and enable the bridge. |
| Telegram `error` | The status tooltip / server log has the Telegram error text. |
| Wake word does nothing | Chrome/Edge, mic permission, tab open, and wake toggle on. |
| MCP server fails | Run its command manually once (`npx -y …`); check Node is on PATH. |
| Google says not connected | Save `secrets/google_client.json`, enable Gmail + Calendar APIs, then run `npm run google-auth`. |
| Browser will not start | Set `integrations.browser.path` to `chrome.exe` or `msedge.exe`; make sure no other process owns the debug port. |
| `Host … is not allowlisted` | Add the exact host or `*.domain` to `integrations.http.allowedHosts`. |
| PDF text is missing | Scanned PDFs need OCR; install `pypdf` for better text extraction. |
| Port busy | Change `server.port` in config or stop the other process. |
| `Command "x" is not allowed` | Add `x` in **Settings → Sandbox → Allowed commands**. Programs run without a shell, so use separate calls instead of `&&`, pipes or redirection. |
| Workspace rejected | Use an absolute path that is writable, is not a file, and is not inside the project's `secrets/` folder. |

## 14. Layout

```
server/   index.mjs (HTTP + SSE), agent.mjs (loop), llm.mjs, tools.mjs, mcp.mjs,
          store.mjs (SQLite), telegram.mjs, skills.mjs, config.mjs, selfcheck.mjs,
          browser.mjs, google.mjs, google-auth.mjs, docs.mjs, docs.py, vision.mjs,
          github.mjs, git.mjs, http.mjs
web/      index.html, style.css, app.js (no build step)
skills/   research, coding
secrets/  model_key.txt, telegram_token.txt (gitignored)
data/     jarvis.db (gitignored)
workspace/ default sandbox for file and shell tools (gitignored; change in Settings)
```

Self-check: `node server/selfcheck.mjs`.

---

*Not checked: real Telegram delivery, a live model, and actual microphone capture require your accounts/hardware. Everything else is exercised locally.*
