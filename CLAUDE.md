# Meridian — Project Brief

## Overview

Meridian is a personal productivity desktop application for a senior engineer and scrum master that
combines AI-assisted feature delivery with engineering leadership tooling. Built on a pipeline
of specialized Claude sub-agents and a metrics dashboard drawing from JIRA and Bitbucket.
Built for individual use — not distributed.

## Core Philosophy

- Each agent has a single, focused responsibility
- Human remains in the loop at the critical decision point (implementation planning)
- Code is never written before a plan is agreed upon
- Nothing is merged without tests and a review pass
- The system improves over time via Agent Skills that encode accumulated knowledge
- Data from JIRA and Bitbucket is the source of truth for all metrics — no manual input

---

## Landing Page / Dashboard Hub

The landing page is the entry point to the app. It presents four distinct workflow cards
the user can navigate into. It should also surface a lightweight at-a-glance summary of
the current sprint status (e.g. tickets completed vs total, PRs awaiting review) so the
user gets immediate context without having to navigate into the Sprint Dashboard.

### Workflow Cards

1. **Implement a Ticket**
   - Shows tickets assigned to the user in the current active sprint (from JIRA)
   - User selects a ticket to begin the full agent implementation pipeline
   - Badge/indicator if a ticket already has an in-progress implementation session

2. **Review a Pull Request**
   - Shows open PRs in Bitbucket where the user is an assigned reviewer
   - Displays PR title, author, age, and ticket link
   - User selects a PR to enter the AI-assisted PR review workflow

3. **Sprint Dashboard**
   - Overview of the current sprint's health and team performance
   - Navigates to the full Sprint Dashboard view (see below)

4. **Sprint Retrospectives**
   - Browse and analyse completed past sprints
   - Navigates to the Retrospective view (see below)

5. **Daily Standup Briefing**
   - One-click standup agenda generated from JIRA and Bitbucket activity
   - Shows what each team member completed yesterday, is working on today, and is blocked by
   - Navigates to the Standup Briefing view (see below)

6. **Team Workload Balancer**
   - Visual overview of current ticket assignments and remaining story points per developer
   - AI-suggested rebalancing recommendations based on capacity and ticket complexity
   - Navigates to the Workload Balancer view (see below)

7. **Ticket Quality Checker**
   - Run any backlog or upcoming sprint ticket through a readiness assessment
   - Checks acceptance criteria completeness, scope clarity, dependency identification
   - Navigates to the Ticket Quality Checker view (see below)

8. **Knowledge Base / Decision Log**
   - Searchable log of architectural decisions, codebase patterns, and retrospective learnings
   - Navigates to the Knowledge Base view (see below)

---

## Workflow 1: Implement a Ticket

See **Agent Pipeline** section below for the full sub-agent breakdown.
This is the primary workflow — a pipeline of 8 sub-agents taking a ticket from grooming
through to a raised PR.

---

## Workflow 2: PR Review Assistant

**Purpose**: Help the user perform thorough, consistent code reviews on PRs they are
assigned to in Bitbucket.

**Entry point**: User selects an open PR from the landing page list.

**Data sources**:
- Bitbucket API: PR diff, PR description, comments, commit history, linked ticket
- JIRA API: The linked ticket's acceptance criteria and context

**Behavior**:
- Fetch the full PR diff and description from Bitbucket
- Fetch the linked JIRA ticket for context on intent and acceptance criteria
- Analyse the diff across four distinct lenses and produce a structured report for each:

  **1. Acceptance Criteria Compliance**
  - Does the implementation address everything in the ticket's acceptance criteria?
  - Are there criteria that are partially addressed or missing entirely?
  - Does the PR description accurately reflect what was actually implemented?

  **2. Security & Vulnerability Analysis**
  - Injection vulnerabilities: SQL, command, path traversal, XSS, etc.
  - Authentication and authorisation issues: missing checks, privilege escalation, insecure
    defaults
  - Sensitive data exposure: secrets or credentials hardcoded, PII logged or leaked,
    unencrypted sensitive data
  - Insecure dependencies: newly introduced packages with known vulnerabilities
  - Input validation gaps: unsanitised user input, missing boundary checks
  - Cryptographic issues: weak algorithms, improper key handling, insecure randomness
  - Each finding must cite the specific file and line range in the diff

  **3. Logic Error Analysis**
  - Off-by-one errors, incorrect boundary conditions, or flawed loop logic
  - Race conditions or concurrency issues
  - Incorrect assumptions about null, undefined, or empty state
  - Error handling gaps: exceptions swallowed, errors not propagated correctly
  - Incorrect conditional logic or inverted boolean expressions
  - State mutations that could produce unexpected side effects
  - Each finding must cite the specific file and line range in the diff

  **4. General Code Quality**
  - Missing or inadequate tests for the changes introduced
  - Adherence to existing codebase patterns and conventions
  - Readability and maintainability concerns
  - Performance considerations worth flagging

- Surface a structured review summary to the user with findings organised by lens
- Each finding is categorised as: Blocking / Non-blocking / Nitpick
- Security and logic error findings default to Blocking unless explicitly assessed otherwise
- Overall assessment: Approve / Request changes / Needs discussion
- User can accept, edit, or discard individual suggested comments before submitting
- (Stretch goal) Submit review comments and approval/rejection via Bitbucket API

**UI**:
- Split view: diff on one side, AI review summary and suggested comments on the other
- Review summary is tabbed by lens: Acceptance Criteria / Security / Logic / Quality
- Security and logic error findings are visually distinct (e.g. red/amber badges) to ensure
  they are not overlooked
- User can toggle individual suggested comments on/off before submitting
- Findings with file/line citations are clickable — highlights the relevant line in the diff

---

## Workflow 3: Sprint Dashboard

**Purpose**: Give the scrum master a real-time view of the current sprint's health,
team performance, and individual developer breakdowns.

**Data sources**:
- JIRA API: sprint details, ticket statuses, story points, assignees, blockers, labels
- Bitbucket API: PRs raised, PRs merged, PR review times, commit activity per developer

### Dashboard Sections

#### Sprint Overview (top-level health)
- Sprint name, start date, end date, days remaining
- Total story points: committed vs completed vs remaining
- Ticket status breakdown: To Do / In Progress / In Review / Done (visual chart)
- Burn-down or burn-up chart across the sprint timeline
- Number of blocked tickets and what is blocking them
- PRs currently open vs merged this sprint

#### Team Performance
- Story points completed per developer (bar chart)
- Tickets completed per developer
- PRs raised and merged per developer
- Average PR review turnaround time per developer (time from PR open to merge)
- PRs awaiting review with age indicator (flag stale PRs)

#### Individual Developer Breakdown
- Drill-down view per developer showing:
  - Their assigned tickets and current status
  - PRs they've raised this sprint
  - PRs they've been asked to review and their response time
  - Story points completed vs assigned

#### Blockers & Risks Panel
- Tickets flagged as blocked in JIRA
- Tickets with no activity for more than N days (configurable)
- PRs open for more than N days without a review (configurable)
- Tickets not yet started with fewer than N days remaining in sprint

#### AI Sprint Health Summary (Claude-powered)
- A brief natural language summary of the sprint's health generated by Claude
- Highlights: what's going well, what's at risk, what needs the scrum master's attention
- Refreshable on demand — not auto-running continuously

---

## Workflow 4: Sprint Retrospectives

**Purpose**: Allow the scrum master to review completed past sprints for retrospective
meetings and trend analysis across sprints.

**Data sources**:
- JIRA API: completed sprint data, ticket statuses at close, story points, velocity
- Bitbucket API: PR and commit activity during the sprint period

### Retrospective View

#### Sprint Selector
- List of all completed sprints, selectable by name/date
- Ability to compare two sprints side by side

#### Per-Sprint Metrics
- Velocity: story points committed vs completed
- Ticket completion rate: % of committed tickets delivered
- Carry-over: tickets not completed and rolled into next sprint
- Scope change: tickets added or removed mid-sprint
- PR metrics: total PRs raised, merged, average time to merge
- Individual developer performance breakdown (same metrics as Sprint Dashboard)

#### Trend Analysis (across multiple sprints)
- Velocity trend chart over last N sprints
- Completion rate trend
- Average PR cycle time trend
- Recurring blockers or patterns across sprints

#### AI Retrospective Summary (Claude-powered)
- Claude generates a retrospective summary for the selected sprint:
  - What went well
  - What didn't go well
  - Patterns compared to previous sprints
  - Suggested discussion points for the retro meeting
- Exportable as markdown or plain text to paste into a retro document

---

## Workflow 5: Daily Standup Briefing

**Purpose**: Give the scrum master a ready-to-run standup agenda every morning with zero
manual prep, generated from actual JIRA and Bitbucket activity.

**Entry point**: Workflow card on the landing page. Intended to be opened first thing each
morning.

**Data sources**:
- JIRA API: ticket status changes from the previous working day, current blockers, assignees
- Bitbucket API: PRs raised, PRs merged, PR comments from the previous working day

**Behavior**:
- Automatically detect the previous working day (handle weekends and skip them)
- For each team member, compile:
  - What they completed or progressed yesterday (ticket status changes, PRs merged)
  - What they are currently working on today (tickets in progress)
  - What they are blocked on (tickets flagged as blocked in JIRA)
- Claude generates a natural language standup summary per person, formatted as a
  ready-to-read agenda the scrum master can work through in the meeting
- Proactively flag items worth raising that team members may not surface themselves:
  - Tickets in progress for more than N days with no PR raised (configurable threshold)
  - PRs open for more than N days without a review
  - Tickets not yet started that are at risk given sprint time remaining
  - Team members with no recorded activity yesterday

**UI**:
- Clean per-person cards, collapsible, ordered by priority (blocked first)
- One-click copy of the full agenda to clipboard for pasting into Slack or a meeting tool
- Refresh button to re-generate if the user opens it again later in the day
- Configurable: user can set the staleness thresholds for flagging at-risk items

---

## Workflow 6: Team Workload Balancer

**Purpose**: Give the scrum master a clear picture of how work is distributed across the
team mid-sprint, and get AI-suggested rebalancing recommendations when imbalances exist.

**Entry point**: Workflow card on the landing page.

**Data sources**:
- JIRA API: all tickets in the current sprint, assignees, story points, current status
- Bitbucket API: PRs currently in review per developer (review load, not just ticket load)

**Behavior**:
- Calculate remaining work per developer: story points of tickets not yet Done
- Factor in review load: developers assigned as reviewers on open PRs have less capacity
- Identify imbalances: developers with significantly more or less remaining work than peers
- Claude analyses the distribution and suggests specific rebalancing moves:
  - Which unstarted tickets could be reassigned and to whom
  - Which developers have capacity to take on more
  - Which developers are at risk of not completing their current load
- Suggestions are advisory only — the user decides whether to act on them
- (Stretch goal) Apply a rebalancing suggestion directly via the JIRA API with user
  confirmation

**UI**:
- Visual capacity bar per developer (remaining story points vs sprint capacity)
- Colour-coded: balanced / over-capacity / under-utilised
- AI suggestions panel alongside the visual, each suggestion actionable with one click
- Drill down into any developer to see their specific ticket breakdown

---

## Workflow 7: Ticket Quality Checker

**Purpose**: Assess whether a ticket is genuinely ready for development before it enters
a sprint. Surfaces gaps in acceptance criteria, unclear scope, missing dependencies, and
open questions that should be resolved during backlog grooming.

**Entry point**: Workflow card on the landing page. User selects a ticket from the backlog
or upcoming sprint to assess.

**Data sources**:
- JIRA API: ticket details — title, description, acceptance criteria, story points, labels,
  linked tickets, epic context
- (Optional) Bitbucket API: check if any referenced branches or PRs already exist

**Behavior**:
- Claude assesses the ticket against a readiness checklist:
  - Does it have clear, testable acceptance criteria?
  - Is the scope well-defined and appropriately sized?
  - Are dependencies on other tickets or systems identified?
  - Are there open questions that need answers before development can begin?
  - Is the ticket's intent unambiguous — could two developers read it differently?
  - Are edge cases and error scenarios considered?
  - Is the story point estimate reasonable given the scope described?
- Produce a structured readiness report:
  - Overall readiness score: Ready / Needs work / Not ready
  - Per-criteria pass/fail with specific feedback
  - Suggested improvements to the ticket description or acceptance criteria
  - Specific questions that should be answered before the ticket enters a sprint
- User can copy the suggested improvements and open the ticket in JIRA to apply them
- (Stretch goal) Apply suggested description improvements directly via the JIRA API with
  user confirmation

**UI**:
- Ticket selector: search or browse backlog and sprint tickets
- Readiness report card with colour-coded criteria checklist
- Suggested rewrites for acceptance criteria shown as diffs (before / after)
- Particularly useful during backlog grooming sessions — designed to be run on multiple
  tickets in sequence

**Note**: This workflow is especially valuable for the capstone project context — running
CS student tickets through the quality checker before sprint planning is a practical way
to teach good ticket writing and definition of done without direct intervention on every
ticket.

---

## Workflow 8: Knowledge Base / Decision Log

**Purpose**: A searchable, persistent log of architectural decisions, codebase patterns,
recurring learnings, and "why did we do it this way" context that accumulates over time
and feeds into Agent Skills.

**Entry point**: Workflow card on the landing page.

**Data sources**:
- User-authored entries (manual)
- Retrospective/Learning Agent outputs (automatic suggestions after ticket completion)
- Retrospective summaries from completed sprints (importable)

### Knowledge Base Structure

#### Decision Log
- Timestamped architectural decisions with context: what was decided, why, what alternatives
  were considered, and what constraints drove the decision
- Tagged by area: architecture / security / performance / patterns / conventions / other
- Searchable by keyword, tag, and date range
- Linked to relevant JIRA tickets or Bitbucket PRs where applicable

#### Codebase Patterns
- Documented patterns in use in the codebase: what they are, when to use them, examples
- Maintained by the user, informed by Retrospective Agent suggestions
- These directly feed the Codebase Patterns Agent Skill

#### Retrospective Learnings
- Imported from Retrospective summaries automatically after sprint completion
- User can promote learnings to formal Decision Log entries or Codebase Patterns
- Trend view: recurring themes across retrospectives

#### Search & Export
- Full-text search across all entries
- Export individual entries or the full log as markdown
- Export selected entries directly into Agent Skills format for use in the implementation
  pipeline

**UI**:
- Clean document-style editor for entries (markdown supported)
- Tag-based filtering and full-text search
- Timeline view and tag/category view
- "Promote to Skill" button on any entry — packages it for use in Agent Skills

---

## Tech Stack

### App Shell
- **Tauri** — desktop executable (cross-platform, lightweight, fast startup)
- Native file system and OS integration via Tauri's Rust backend
- No browser tab required — runs as a proper desktop app

### Frontend
- **React** with **TypeScript**
- **shadcn/ui** — component library (source-owned, fully themeable, built on Radix UI primitives)
- **Tailwind CSS** — styling (bundled with shadcn/ui)

### Agent Layer
- **Claude Agent SDK** (TypeScript) — powers all sub-agents and the subagent pipeline
- **External APIs**: JIRA API, Bitbucket API
- **Auth**: Anthropic API key (platform.claude.com — individual account, pay-as-you-go)

### Skills
- Custom Agent Skills for domain knowledge (grooming conventions, codebase patterns,
  implementation standards, coding style)
- Skills are user-authored — no proprietary codebase content

---

## Agent Pipeline

### 1. Grooming Agent
**Purpose**: Understand the ticket and identify the relevant parts of the codebase.

**Inputs**:
- JIRA ticket(s) assigned to the user in the current sprint (via JIRA API)

**Behavior**:
- Parse the ticket: title, description, acceptance criteria, story points, labels, linked tickets
- Identify which files, modules, and packages in the codebase are likely relevant based on
  the ticket description — do NOT load the entire codebase, be targeted
- Fetch only the relevant portions of main branch from Bitbucket (via Bitbucket API)
- Synthesize a structured understanding of: what the ticket is asking for, relevant existing
  code, and any ambiguities or gaps in the ticket description

**Outputs** (passed to Impact Analysis Agent):
- Ticket summary
- List of relevant files/modules with brief explanation of relevance
- Identified ambiguities
- Raw content of relevant code sections

---

### 2. Impact Analysis Agent
**Purpose**: Understand the blast radius of the planned change before planning begins.

**Inputs**:
- Output from Grooming Agent

**Behavior**:
- Analyze which other modules, services, or files call or depend on the code likely to be
  changed
- Check Git history (via Bitbucket API) for recent changes to the relevant files — understand
  WHY code was written a certain way before suggesting changes to it
- Identify similar patterns elsewhere in the codebase that may need to be updated consistently
- Flag anything that could break, regress, or require coordinated changes
- Assess risk level of the change (low / medium / high) with justification

**Outputs** (passed to Triage Agent):
- Dependency map of affected code
- Risk assessment with justification
- Git history insights on relevant files
- List of files that may need consistent updates alongside the primary change

---

### 3. Triage Agent (Human-in-the-Loop)
**Purpose**: Collaborate with the user to produce a specific, agreed-upon implementation plan.

**Inputs**:
- Output from Grooming Agent
- Output from Impact Analysis Agent

**Behavior**:
- Present a structured briefing to the user: ticket understanding, relevant code, impact
  analysis, and risk level
- Propose a high-level implementation approach
- Use the AskUserQuestion tool to surface uncertainties and ask targeted clarifying questions
- Incorporate user clarifications and course-corrections
- Iterate until consensus is reached
- Produce a final, structured implementation plan

**Human-in-the-loop**: This is the primary checkpoint. The user can clarify requirements,
correct misunderstandings, adjust the approach, or flag constraints the agent is unaware of.

**Outputs** (passed to Implementation Agent):
Structured implementation plan including:
- Files to create, modify, or delete
- Specific changes per file with reasoning
- Order of operations
- Edge cases to handle
- Anything the implementation agent should NOT change and why
- Confirmed assumptions and resolved questions

---

### 4. Implementation Agent
**Purpose**: Execute the agreed implementation plan precisely.

**Inputs**:
- Structured implementation plan from Triage Agent
- Access to relevant codebase files

**Behavior**:
- Follow the implementation plan exactly — do not deviate without flagging it
- Use Read, Edit, Write, Bash, Glob, and Grep tools to navigate and modify the codebase
  locally
- Respect existing patterns, naming conventions, and architecture decisions
- If a deviation from the plan is necessary, pause and surface it to the user before proceeding
- Do not write tests (that is the Test Generation Agent's responsibility)

**Outputs**:
- Modified/created source files
- Summary of what was changed and why, noting any deviations from the plan

---

### 5. Test Generation Agent
**Purpose**: Write thorough tests for the implemented code.

**Inputs**:
- Implementation Agent's output (what changed and why)
- The relevant source files

**Behavior**:
- Analyze the implemented code independently — do not simply confirm the implementation's
  assumptions
- Write unit tests for new/modified logic
- Write integration tests where appropriate
- Aim to challenge the implementation: test edge cases, boundary conditions, and failure modes
- Follow existing test conventions and frameworks already in use in the codebase

**Note**: Kept intentionally separate from the Implementation Agent to prevent an agent from
writing tests that simply validate its own assumptions.

**Outputs**:
- Test files
- Summary of test coverage and any areas deliberately not covered (with reasoning)

---

### 6. Code Review Agent
**Purpose**: Critique the implementation before human or colleague review.

**Inputs**:
- Implementation Agent output
- Test Generation Agent output
- Original implementation plan
- Relevant codebase context

**Behavior**:
- Review the diff against the agreed implementation plan — flag any deviations
- Check for adherence to codebase conventions and coding standards
- Identify potential bugs, edge cases, or logic errors
- Assess test coverage quality
- Flag anything a human reviewer is likely to push back on
- Provide an overall confidence level: Ready for review / Needs attention / Requires rework

**Outputs**:
- Structured review report with categorized findings (blocking / non-blocking / suggestions)
- Confidence level with justification
- List of specific things to address before raising the PR (if any)

---

### 7. PR Description Agent
**Purpose**: Write a thorough, professional pull request description automatically.

**Inputs**:
- Original JIRA ticket
- Agreed implementation plan
- Code diff / summary of changes
- Test summary
- Code review report

**Behavior**:
- Write a clear PR description including: what changed, why it changed, how it was implemented,
  and what was tested
- Auto-link the JIRA ticket
- Summarize the test coverage
- Flag anything the reviewer should pay particular attention to
- Note any deviations from the original plan and the reasoning
- Follow any PR template conventions used by the team if provided

**Outputs**:
- Complete PR description ready to paste or submit via Bitbucket API
- (Optional stretch goal) Raise the PR automatically via Bitbucket API pending user approval

---

### 8. Retrospective/Learning Agent
**Purpose**: Improve the system over time by learning from completed tickets.

**Inputs**:
- Original JIRA ticket
- Original implementation plan (from Triage Agent)
- Final implemented code
- Code review findings
- Any deviations noted along the way

**Behavior**:
- Compare the original plan to what was actually built — identify where and why they diverged
- Identify patterns: recurring ambiguities, common risk areas, types of tickets that need more
  grooming, etc.
- Produce recommendations for updating Agent Skills to encode new learnings
- Over time, this agent makes the grooming and triage agents progressively smarter about the
  specific codebase and team conventions

**Outputs**:
- Retrospective summary
- Suggested updates to relevant Agent Skills

---

## Agent Skills to Build

Custom Skills that load domain expertise into agents automatically:

- **Grooming conventions skill**: How to interpret tickets in this team's context, which JIRA
  fields matter most, how to assess scope and ambiguity
- **Codebase patterns skill**: Architectural patterns, module structure, key abstractions,
  things to be aware of when navigating the codebase
- **Implementation standards skill**: Coding style, naming conventions, patterns to follow
  and patterns to avoid
- **Review standards skill**: What good looks like, common issues to flag, team-specific
  conventions the review agent should enforce

---

## Full Pipeline Summary

```
JIRA API
    ↓
[1. Grooming Agent]
    ↓
[2. Impact Analysis Agent]
    ↓
[3. Triage Agent] ←→ USER (clarification loop)
    ↓ (agreed plan)
[4. Implementation Agent]
    ↓
[5. Test Generation Agent]
    ↓
[6. Code Review Agent]
    ↓
[7. PR Description Agent]
    ↓
USER approves → PR raised to Bitbucket

(After merge)
    ↓
[8. Retrospective/Learning Agent]
    ↓
Skills updated
```

---

## Onboarding & Settings

### First-Run Onboarding
On first launch, if no credentials are configured, the app must route the user to an
onboarding screen before showing the landing page. The onboarding screen walks the user
through entering all required credentials in a single guided flow with clear labels,
helper text, and validation feedback.

Do NOT use environment variables for credentials — all credentials are entered via the UI
and stored securely by the app.

### Credentials Required
- **Anthropic API Key** — from platform.claude.com. Used to power all Claude sub-agents.
- **JIRA Base URL** — the user's JIRA workspace URL (e.g. https://yourcompany.atlassian.net)
- **JIRA Email** — the email address associated with the JIRA account
- **JIRA API Token** — generated from Atlassian account settings
- **Bitbucket Workspace** — the Bitbucket workspace slug
- **Bitbucket Username** — the Bitbucket account username
- **Bitbucket App Password** — generated from Bitbucket account settings (scoped to
  repository read and pull request read/write permissions)

### Settings Screen
Accessible at any time from a persistent settings icon in the app's navigation. Allows
the user to view and update any of the above credentials. Each credential field should:
- Mask the value by default (show/hide toggle)
- Validate the credential on save by making a lightweight test API call
- Show a clear success or error state after validation
- Never expose the raw value in logs or error messages

### Credential Storage
- All credentials are stored using **Tauri's secure OS keychain integration**
  (tauri-plugin-stronghold or the OS keychain via tauri-plugin-keychain)
- Credentials are never written to disk in plaintext
- Credentials are never passed to the React frontend — they are read in the Tauri backend
  layer and used directly in API calls and agent SDK initialisation
- No credential should ever appear in a Tauri command response to the frontend

### Onboarding UX Flow
1. Welcome screen — brief description of what the app does and what it needs access to
2. Anthropic API Key entry — with a link to platform.claude.com to get a key
3. JIRA credentials entry — URL, email, and API token, with a link to Atlassian docs
4. Bitbucket credentials entry — workspace, username, and app password, with a link to
   Bitbucket docs on generating app passwords
5. Validation step — test all three integrations simultaneously, show per-integration
   success/failure with actionable error messages
6. Done — route to the landing page

The user can re-enter or skip individual steps and return to complete them later via
Settings, but the landing page should show a persistent warning banner if any credentials
are missing or invalid.

---

## Privacy & Data Considerations

- API calls are stateless — no codebase content is retained between sessions by default
- Training opt-out enabled on the API account (platform.claude.com settings)
- Agent Skills contain only user-authored conventions — no proprietary code
- Proprietary codebase content is passed at runtime only, not stored in Skills
- Do not include secrets, credentials, or sensitive business logic in Skills

---

## Implementation Notes for Claude Code

### Build Order
1.  Scaffold the Tauri + React + TypeScript + shadcn/ui project structure first
2.  Build the Onboarding and Settings screens — credential entry, secure storage, and
    validation against all three APIs (Anthropic, JIRA, Bitbucket). Nothing else works
    without this, and it forces the data layer to be proven early
3.  Wire up JIRA API and Bitbucket API integrations fully and validate data is flowing
    correctly before building any agents or dashboards
4.  Build the Landing Page hub with all eight workflow cards (placeholders initially) —
    establish navigation structure early so all subsequent work drops into a real shell
5.  Build Workflow 3 (Sprint Dashboard) — data-only, no agents, validates the full
    JIRA/Bitbucket data pipeline and produces immediately useful output
6.  Build Workflow 4 (Retrospectives) — shares the same data layer as the Sprint Dashboard,
    low incremental effort once the dashboard is working
7.  Build Workflow 5 (Daily Standup Briefing) — lightweight Claude call on top of data
    already proven in steps 5 and 6; high immediate value, low complexity
8.  Build Workflow 6 (Team Workload Balancer) — data-only with a Claude advisory layer;
    shares the sprint data pipeline already built
9.  Build Workflow 8 (Knowledge Base / Decision Log) — UI-only at this stage, no agents;
    gets the persistence layer in place so Retrospective and Learning agents can write to it
10. Build Workflow 7 (Ticket Quality Checker) — single-agent Claude workflow, good warm-up
    before the full implementation pipeline
11. Build Workflow 2 (PR Review Assistant) — introduces the diff/code review agent pattern
    that the implementation pipeline will also use
12. Build Workflow 1 (Implement a Ticket) — the full 8-agent pipeline, built and tested
    agent by agent before wiring together
13. Implement the Triage Agent human-in-the-loop UI carefully — most interactive part,
    needs the most iteration
14. Wire Retrospective/Learning Agent outputs into the Knowledge Base (step 9 prepared this)
15. Add Agent Skills last, once the full pipeline behaviour is stable

### General Guidelines
- Use **TypeScript throughout** — both the Tauri frontend and the Claude Agent SDK layer
- Use **structured outputs (JSON)** for all inter-agent handoffs to keep the pipeline reliable
  and type-safe
- Use **shadcn/ui components** for all UI — do not build custom components where shadcn/ui
  has a suitable option
- Apply a **consistent theme** via Tailwind CSS variables from the start — easier than
  retrofitting later
- Add **cost tracking from the start** — the Claude Agent SDK has built-in cost tracking;
  surface per-agent and per-ticket token costs in the UI so usage is visible
- Use **prompt caching** for codebase context passed to multiple agents — the same files will
  be read by several agents in a single pipeline run, caching will reduce cost meaningfully
- Agent SDK calls run in the **Tauri backend layer**, not in the React frontend — keep API
  keys and agent logic server-side, only pass results to the frontend via Tauri commands
- Store JIRA, Bitbucket, and Anthropic credentials securely using **Tauri's secure storage**,
  never hardcoded or in frontend state
