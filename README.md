<div align="center">
  <img src="public/meridian-readme.svg" alt="Meridian" width="240" height="240" />
</div>

# Meridian

A personal productivity desktop application for a senior engineer and scrum master. Meridian combines an AI-assisted ticket implementation pipeline with engineering leadership tooling — sprint dashboard, retrospectives, PR review, ticket quality checks, and meeting transcription — all drawing from JIRA and Bitbucket as the single source of truth.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | [Tauri v2](https://tauri.app) (Rust backend, native OS integration) |
| Frontend | React 18 + TypeScript, Zustand for state, Recharts for charts |
| UI components | [shadcn/ui](https://ui.shadcn.com) + Tailwind CSS |
| AI orchestration | Node.js sidecar running the [Claude Agent SDK](https://docs.claude.com/en/docs/claude-code/sdk) |
| LLM providers | Claude (Anthropic), Gemini (Google), GitHub Copilot, local OpenAI-compatible servers |
| Speech-to-text | Local Whisper (no audio leaves the machine) |
| Data sources | JIRA REST API, Bitbucket REST API |
| Credential storage | AES-256-GCM encrypted file in the app data directory; key derived from `SHA256(domain ‖ machine UUID)` |

---

## Features

### Implement a Ticket (8-agent pipeline)
The primary workflow. Select a JIRA ticket and run it through a sequenced pipeline of sub-agents, with a human checkpoint after every step:

1. **Grooming** — Parses the ticket, blocks on missing AC / description / story points
2. **Impact Analysis** — Maps dependencies, blast radius, and risk
3. **Triage** — Iterative human-in-the-loop planning conversation
4. **Implementation** — Writes the code (no tests — that is step 5's job)
5. **Test Generation** — Generates unit and integration tests independently
6. **Code Review** — Reviews the diff against the agreed plan
7. **PR Description** — Drafts the pull request description from a configurable template
8. **Retrospective** — Captures learnings and proposes Agent Skill updates

All agents operate against a local git worktree (sandboxed file access via `glob`, `grep`, `read_file`, `write_file`), never the Bitbucket API.

### PR Review Assistant
AI-assisted code review across four lenses with a chat window for follow-ups:
- Acceptance criteria compliance
- Security & vulnerability analysis
- Logic error analysis
- General code quality

Findings are categorised as Blocking / Non-blocking / Nitpick and cite specific file and line ranges.

### Address PR Comments
Reads reviewer comments on your open PRs, checks the branch out into a dedicated worktree, and proposes / applies fixes — separate from the implementation and PR-review worktrees so all three workflows can run concurrently without branch conflicts.

### Sprint Dashboard
Real-time sprint health: story points, burndown, blockers, PR cycle times, per-developer capacity bars with AI rebalancing suggestions, an AI-generated health summary, and a "Needs Verification" list. Also the launch point for standup recordings.

### Sprint Retrospectives
Browse completed sprints, view multi-sprint velocity and trend charts, and generate AI retrospective summaries with embedded charts. Exportable as markdown.

### Groom Ticket
Runs any backlog ticket through a readiness assessment — acceptance criteria completeness, scope clarity, dependency identification, and suggested rewrites.

### Meetings
Two ways to capture meetings: local Whisper transcription (one-click via the header record button on any screen — auto-tagged "standup" from Sprint Dashboard, "retro" from Retrospectives, with speaker diarization and rename), or freeform written notes for meetings where recording is not permitted. Either mode is taggable, timestamped, and summarisable on demand by the AI; meeting summaries also feed into Sprint Retrospectives.

---

## Prerequisites

- [Node.js](https://nodejs.org) 20+
- [Rust](https://rustup.rs) (stable toolchain)
- [Tauri CLI v2](https://tauri.app/start/prerequisites/)
- macOS (the credential store derives its encryption key from the machine's `IOPlatformUUID`; ports to other platforms would need an equivalent stable per-machine identifier)
- [Whisper](https://github.com/openai/whisper) installed locally if you intend to use meeting transcription

---

## Development

```bash
# Install frontend dependencies
npm install

# Build the Node.js Claude Agent SDK sidecar
npm --prefix src-sidecar install
npm --prefix src-sidecar run build

# Start the Tauri dev server (hot-reload)
npm run tauri dev
```

The Vite dev server runs on `http://localhost:1420` and Tauri opens a native window pointed at it.

```bash
# Run the test suite
npm test
```

---

## Building

```bash
npm run tauri build
```

Artifacts are written to `src-tauri/target/release/bundle/`.

---

## First-Run Setup

On first launch the app routes to an onboarding screen where you provide:

| Credential | Where to get it |
|---|---|
| **Anthropic API key** (or OAuth) | [platform.claude.com](https://platform.claude.com) → API Keys |
| **JIRA base URL** | Your Atlassian workspace URL, e.g. `https://yourcompany.atlassian.net` |
| **JIRA email** | The email on your Atlassian account |
| **JIRA API token** | [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| **Bitbucket workspace** | Your Bitbucket workspace slug |
| **Bitbucket username** | Your Bitbucket account username |
| **Bitbucket app password** | Bitbucket → Settings → App passwords (repo read + PR read/write) |

You also configure the local repo worktree the agent pipeline operates against:

| Setting | Purpose |
|---|---|
| **Repo worktree path** | Absolute path to the worktree the implementation pipeline writes to |
| **PR review worktree path** | Separate worktree used by PR Review (avoids branch conflicts) |
| **PR address worktree path** | Separate worktree used by Address PR Comments |
| **Repo base branch** | Branch the worktree tracks (default: `develop`) |

All credentials are persisted to `credentials.bin` inside the Tauri app data directory (`~/Library/Application Support/<app id>/` on macOS) — encrypted at rest with AES-256-GCM under a key derived from `SHA256("meridian-credential-store-v1:" ‖ <machine UUID>)`. The store is read in the Rust backend only and per-request passed to the sidecar over stdio IPC; credentials are never exposed to the React frontend, never logged, and never written to disk in plaintext. Because the encryption key is bound to the machine's `IOPlatformUUID`, copying `credentials.bin` to another machine yields ciphertext that won't decrypt there.

Credentials and settings can be updated at any time via the **Settings** screen (gear icon, top-right).

---

## AI Provider Priority

Meridian supports multiple AI providers with automatic fallback:

1. **Claude** (Anthropic) — primary, supports API keys and OAuth tokens
2. **Gemini** (Google) — secondary fallback
3. **GitHub Copilot** — tertiary fallback (uses your Copilot subscription)
4. **Local LLM** — Ollama or any OpenAI-compatible server

Provider order and credentials are configured in Settings. When a provider returns a quota or rate-limit error, Meridian automatically tries the next in the chain.

---

## Project Structure

```
meridian/
├── src/                         # React frontend
│   ├── components/              # Shared UI components
│   ├── screens/                 # Full-page screen components
│   ├── stores/                  # Zustand stores
│   ├── lib/                     # Utilities, Tauri bindings, theme
│   └── providers/               # React context providers
├── src-sidecar/                 # Node.js Claude Agent SDK sidecar
│   └── src/                     # Agent runtime, Gemini bridge, IPC protocol
├── src-tauri/                   # Rust/Tauri backend
│   └── src/
│       ├── agents/              # Pipeline agents (grooming, planning, implementation, review…)
│       ├── commands/            # Tauri commands exposed to the frontend
│       ├── integrations/        # JIRA, Bitbucket, sidecar process management
│       ├── llms/                # Claude / Gemini / Copilot / local-LLM clients
│       └── storage/             # Credentials, preferences, store cache
├── docs/                        # Internal design notes
├── scripts/                     # Debug helpers (JIRA, Bitbucket)
└── public/                      # Static assets
```

---

## Notes

- Built for individual use — not distributed publicly.
- API calls are stateless; no codebase content is retained between sessions.
- Training opt-out should be enabled on your Anthropic account ([platform.claude.com](https://platform.claude.com) → Settings → Privacy).
- Meeting audio is transcribed locally via Whisper — it never leaves your machine.

---

## Credits

- **Black-hole animation** (`public/bh.webp`) — adapted from a NASA visualisation of light bending around a Schwarzschild black hole.
  Credit: **NASA's Goddard Space Flight Center / Jeremy Schnittman / Scott Noble.**
