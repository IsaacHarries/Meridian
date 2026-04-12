<div align="center">
  <img src="public/meridian-readme.svg" alt="Meridian" width="240" height="240" />
</div>

# Meridian

A personal productivity desktop application for a senior engineer and scrum master. Meridian combines an AI-assisted ticket implementation pipeline with engineering leadership tooling — sprint dashboards, retrospectives, standup briefings, workload balancing, and more — all drawing from JIRA and Bitbucket as the single source of truth.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | [Tauri v2](https://tauri.app) (Rust backend, native OS integration) |
| Frontend | React 18 + TypeScript |
| UI components | [shadcn/ui](https://ui.shadcn.com) + Tailwind CSS |
| AI agents | Claude API (Anthropic) via direct REST — Gemini and local LLM supported as fallbacks |
| Data sources | JIRA REST API, Bitbucket REST API |
| Credential storage | macOS Keychain (via `security` CLI) |

---

## Features

### Implement a Ticket (8-agent pipeline)
The primary workflow. Select a JIRA ticket and run it through a sequenced pipeline of Claude sub-agents:

1. **Grooming** — Parses the ticket and identifies relevant codebase areas
2. **Impact Analysis** — Maps dependencies and assesses blast radius
3. **Triage** — Human-in-the-loop planning session; produces an agreed implementation plan
4. **Implementation Guide** — Concrete, step-by-step implementation instructions
5. **Test Suggestions** — Generates unit and integration test recommendations
6. **Plan Review** — Code-review pass against the agreed plan
7. **PR Description** — Writes a complete, professional pull request description
8. **Retrospective** — Captures learnings and suggests Agent Skill updates

### Sprint Dashboard
Real-time view of sprint health — story points, burndown, team performance, PR cycle times, blockers, and an AI-generated health summary.

### Sprint Retrospectives
Browse completed sprints, view velocity trends, and generate AI retrospective summaries exportable as markdown.

### Daily Standup Briefing
One-click standup agenda generated from yesterday's JIRA and Bitbucket activity. Per-person cards with what was done, what's in progress, and what's blocked.

### Team Workload Balancer
Visual capacity bars per developer with AI-suggested rebalancing recommendations.

### Ticket Quality Checker
Runs any backlog ticket through a readiness assessment — acceptance criteria completeness, scope clarity, dependency identification, and suggested rewrites.

### Knowledge Base / Decision Log
Searchable, persistent log of architectural decisions, codebase patterns, and retrospective learnings. Entries can be promoted into Agent Skills.

### PR Review Assistant
AI-assisted code review across four lenses: acceptance criteria compliance, security analysis, logic error detection, and general code quality. Findings are categorised as Blocking / Non-blocking / Nitpick.

---

## Prerequisites

- [Node.js](https://nodejs.org) 20+
- [Rust](https://rustup.rs) (stable toolchain)
- [Tauri CLI v2](https://tauri.app/start/prerequisites/)
- macOS (credential storage uses the macOS Keychain)

---

## Development

```bash
# Install frontend dependencies
npm install

# Start the Tauri dev server (hot-reload)
npm run tauri dev
```

The Vite dev server runs on `http://localhost:1420` and Tauri opens a native window pointed at it.

---

## Building

```bash
# Produce a signed, distributable .app / .dmg
npm run tauri build
```

Artifacts are written to `src-tauri/target/release/bundle/`.

---

## First-Run Setup

On first launch the app routes to an onboarding screen where you provide:

| Credential | Where to get it |
|---|---|
| **Anthropic API key** | [platform.claude.com](https://platform.claude.com) → API Keys |
| **JIRA base URL** | Your Atlassian workspace URL, e.g. `https://yourcompany.atlassian.net` |
| **JIRA email** | The email on your Atlassian account |
| **JIRA API token** | [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| **Bitbucket workspace** | Your Bitbucket workspace slug |
| **Bitbucket username** | Your Bitbucket account username |
| **Bitbucket app password** | Bitbucket → Settings → App passwords (repo read + PR read/write) |

All credentials are stored in the macOS Keychain — never written to disk in plaintext and never exposed to the frontend.

Credentials can be updated at any time via the **Settings** screen (gear icon, top-right).

---

## AI Provider Priority

Meridian supports multiple AI providers with automatic fallback:

1. **Claude** (Anthropic) — primary, supports API keys and OAuth tokens
2. **Gemini** (Google) — secondary fallback
3. **Local LLM** — Ollama or any OpenAI-compatible server

Provider order and credentials are configured in Settings. When a provider returns a quota or rate-limit error, Meridian automatically tries the next in the chain.

---

## Project Structure

```
meridian/
├── src/                    # React frontend
│   ├── components/         # Shared UI components
│   ├── lib/                # Utilities, space effects, Tauri bindings
│   └── screens/            # Full-page screen components
├── src-tauri/              # Rust/Tauri backend
│   └── src/
│       └── commands/       # Tauri commands (claude.rs, credentials.rs, …)
└── public/                 # Static assets
```

---

## Notes

- Built for individual use — not distributed publicly.
- API calls are stateless; no codebase content is retained between sessions.
- Training opt-out should be enabled on your Anthropic account ([platform.claude.com](https://platform.claude.com) → Settings → Privacy).
