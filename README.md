# SDLC Agent System

An AI-powered, multi-agent orchestration system that transforms a plain-language description of what you want to build into production-ready, tested, and documented software. A coordinated pipeline of eight specialized AI agents handles everything from requirements gathering to post-ship handoff — with human gates at every phase boundary, machine-checked evidence backing the review gate, and a local commit history for everything that gets generated.

---

## How It Works

You describe what you want to build. The system runs it through a lifecycle with a human gate at each phase boundary:

```
Access Check ──▶ Intake ──▶ Architecture ──▶ Design Review (approval loop)
                                                     │
                                                     ▼
                                                  Builder
                                                     │
                                                     ▼
                                            Demo Checkpoint (human)
                                                     │
                                                     ▼
                         ┌── Static Analysis (type-check / lint / audit, sandboxed)
                         │              │
                         │              ▼
                         │           Reviewer ──▶ Verifier (adversarial 2nd pass, per finding)
                         │              │
                         │       verifiedApproved?
                         │         │           │
                         │        yes          no
                         │         │           ▼
                         │         │        Debugger ──┐
                         │         │           ▲        │ (fix loop)
                         │         │           └────────┘
                         ▼         ▼
                              QA (sandboxed exec) ──▶ Debugger (fix loop)
                                     │
                                     ▼
                                  Delivery (Ship)
                                     │
                                     ▼
                              Hypercare & Handoff
                                     │
                                     ▼
                     output/session-*/  (local git history, per-stage commits)
```

Each stage produces a structured artifact that feeds the next, and every artifact is appended to a durable session record rather than overwritten. Failed reviews and failing tests automatically re-engage the Debugger for up to a configurable number of iterations before proceeding.

---

## Agents

| Agent | Model | Role |
|---|---|---|
| **Intake** | Claude Opus 4.7 | Asks targeted clarifying questions, then synthesizes a structured `ProductBrief` |
| **Architect** | Claude Opus 4.7 | Designs the full system: tech stack, components, data models, API contracts, security considerations, ASCII diagram |
| **Builder** | Claude Sonnet 4.6 | Generates complete, production-ready source code — no stubs, no TODOs |
| **Static Analysis** | (no LLM) | Runs type-checking, linting, and a dependency audit in a sandbox; feeds the Reviewer machine-checked evidence instead of asking it to simulate this from reading source |
| **Reviewer** | Claude Opus 4.7 | Reviews all generated code against the brief, architecture spec, and static analysis results; classifies issues by severity and category |
| **Verifier** | Claude Opus 4.8 | Adversarial second pass — independently re-checks every Reviewer finding against the actual file before it's allowed to count toward blocking. Catches the Reviewer hallucinating or misreading an issue, not just missing one |
| **Debugger** | Claude Sonnet 4.6 | Receives verified issue lists from the Reviewer or failed tests from QA and produces corrected files |
| **QA** | OpenAI Codex (`gpt-5.4`) | Generates 100–200 test cases, installs dependencies and executes them in a sandboxed, network-isolated container, reports failures |
| **Delivery** | Claude Sonnet 4.6 | Compiles the final package: architecture doc, code review summary (with analysis + verifier evidence), QA report, and deployment guide |

**Gating philosophy:** the Reviewer's own `approved` flag is recorded as evidence but is never authoritative. The pipeline gates on `verifiedApproved` — computed after the Verifier pass — so a single model's self-assessment can't silently wave through a bad review. Reviewer and QA responses that come back truncated or malformed fail *closed* (block and retry, then escalate) rather than defaulting to approved.

**Human-in-the-loop gates:**
1. **Access Check** — confirm prerequisites and credentials before requirements gathering starts.
2. **Design Review** — after the Architect stage, approve or request revisions to the architecture (loops until approved).
3. **Demo Checkpoint** — after the Builder stage, review the generated structure before the automated quality gates run; notes captured here are passed directly into the Reviewer's context.
4. **Hypercare & Handoff** — after delivery, record the hypercare owner, monitoring window, and handoff notes.

---

## Sandboxing

Generated code is LLM-authored and untrusted. Test execution and static analysis run inside a disposable, resource-limited Docker container when Docker is available (`--network none` for anything executing the generated application/test code; network is enabled only for the install step and dependency-audit checks, which legitimately need registry access). If Docker isn't installed, the pipeline falls back to running directly on the host with a loud warning — it will still work, just without the isolation boundary.

---

## Output

All generated artifacts are written to `output/session-{timestamp}/`, which becomes its own local git repository (commits per stage: initial build, each review/QA fix, the delivery package, hypercare notes). No remote, no push, no PR — this is purely a real, inspectable commit history for the generated codebase instead of silently overwritten files.

```
output/session-{timestamp}/
├── .git/                  # Local commit history, one repo per session (see above)
├── src/                   # All generated source files
├── tests/                 # Generated test suite
├── package.json           # (or requirements.txt, go.mod, etc.)
├── .env.example           # Documented environment variables
└── _delivery/
    ├── ARCHITECTURE.md    # Full architectural overview
    ├── CODE_REVIEW.md     # Review iterations, static analysis results, verifier verdicts
    ├── QA_REPORT.md       # Test results and coverage summary
    ├── DEPLOYMENT.md      # Tech stack-specific deployment guide
    ├── HYPERCARE.md       # Hypercare owner, monitoring window, handoff notes
    └── SESSION.json       # Session metadata
```

---

## Prerequisites

- **Node.js 18+**
- **Anthropic API key** — used by Intake, Architect, Builder, Reviewer, Verifier, Debugger, and Delivery
- **OpenAI API key** — used by the QA Agent (Codex)
- **Docker** *(optional but recommended)* — sandboxes test execution and static analysis. Without it, both run directly on the host.
- **git** *(optional)* — enables local commit history for generated output. Without it, files are still written, just without version history.

---

## Installation

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
```

Edit `.env` and fill in your API keys:

```env
ANTHROPIC_API_KEY=your_anthropic_key_here
OPENAI_API_KEY=your_openai_key_here
```

---

## Running

```bash
# Development — runs TypeScript directly
npm run dev

# Production — compile first, then run
npm run build
npm start
```

The system will validate your API keys, then prompt: **"What would you like to build?"**

Describe your project in as much or as little detail as you like. The Intake Agent will ask follow-up questions to fill in any gaps before the pipeline begins.

To resume a previous session:

```bash
node dist/index.js --resume=<sessionId> [--from=access_check|intake|architecture|building|demo_checkpoint|code_review|qa|delivery|hypercare]
```

---

## Configuration

All options are set via environment variables in `.env`:

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Required.** Anthropic API key for Claude agents. |
| `OPENAI_API_KEY` | — | **Required.** OpenAI API key for the QA Agent. |
| `QA_MODEL` | `gpt-5.4` | Override the OpenAI model used for QA test generation. |
| `MAX_REVIEW_ITERATIONS` | `5` | Maximum Reviewer → Verifier → Debugger loop iterations before forcing a pass. |
| `MAX_QA_ITERATIONS` | `5` | Maximum QA → Debugger loop iterations before forcing a pass. |

Docker and git are auto-detected at runtime — no configuration needed; the pipeline logs which mode (sandboxed/host, versioned/unversioned) it's running in at each relevant stage.

---

## Project Structure

```
├── src/
│   ├── index.ts               # Entry point
│   ├── orchestrator/
│   │   └── index.ts           # Lifecycle coordination, gates, and feedback loops
│   ├── agents/
│   │   ├── intake.ts
│   │   ├── architect.ts
│   │   ├── builder.ts
│   │   ├── reviewer.ts
│   │   ├── verifier.ts        # Adversarial second pass on review findings
│   │   ├── debugger.ts
│   │   ├── qa.ts
│   │   └── delivery.ts
│   ├── types/
│   │   └── index.ts           # Shared TypeScript interfaces + the three-layer session record
│   └── utils/
│       ├── cli.ts             # Terminal UI, prompts, approval flows
│       ├── state.ts           # Session save/load
│       ├── files.ts           # File I/O, LLM output parsing, path-traversal guards
│       ├── sandbox.ts         # Docker-based sandboxed command execution
│       ├── analysis.ts        # Static analysis (type-check/lint/audit) as review evidence
│       └── git.ts             # Local commit history for generated output
├── dist/                      # Compiled JavaScript (generated)
├── sessions/                  # Session state files (generated at runtime)
├── output/                    # Generated projects, each its own local git repo (created at runtime)
├── .env.example
├── package.json
└── tsconfig.json
```

### Session record

Session state (`SessionState`) is split into three layers rather than one flat bag:

- **`currentTruth`** — the latest approved/built product brief, architecture, and source code.
- **`futureIntent`** — state that's been requested but not yet realized: pending architecture revision notes, demo-checkpoint follow-ups, hypercare handoff details.
- **`history`** — an append-only evidence log: every review report, static analysis run, debug run, and QA result, kept in full rather than overwritten.

---

## Tech Stack

- **TypeScript** (ES2022, strict mode) compiled to CommonJS
- **Anthropic SDK** `^0.39.0` — Claude Opus 4.7/4.8 and Sonnet 4.6
- **OpenAI SDK** `^4.77.0` — Codex for QA
- **Docker CLI** *(external, optional)* — sandboxed execution for tests and static analysis
- **git CLI** *(external, optional)* — local commit history for generated output
- **chalk** — terminal output styling
- **fs-extra** — enhanced file system operations
- **dotenv** — environment variable loading
- **uuid** — session ID generation

Prompt caching (`cache_control: ephemeral`) is applied to system prompts and large inputs across all Claude agents to reduce latency and cost on repeated or iterative runs.
