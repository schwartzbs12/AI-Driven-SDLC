import * as dotenv from 'dotenv';
dotenv.config();

import { runPipeline } from './orchestrator/index';
import { loadSession, listSessions } from './utils/state';
import { header, askMultiline, closeInput, error, info } from './utils/cli';

function parseArgs(): { sessionId?: string; startStage?: string } {
  const args = process.argv.slice(2);
  const sessionId = args.find((a) => a.startsWith('--resume='))?.split('=')[1];
  const startStage = args.find((a) => a.startsWith('--from='))?.split('=')[1];
  return { sessionId, startStage };
}

async function main(): Promise<void> {
  header('Welcome to the SDLC Agent System');

  if (!process.env.ANTHROPIC_API_KEY) {
    error('ANTHROPIC_API_KEY is not set. Please copy .env.example to .env and fill in your keys.');
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    error('OPENAI_API_KEY is not set. The QA agent requires an OpenAI API key.');
    process.exit(1);
  }

  const { sessionId, startStage } = parseArgs();

  if (sessionId) {
    // ── RESUME MODE ────────────────────────────────────────────────────────────
    let state;
    try {
      state = await loadSession(sessionId);
    } catch {
      const available = await listSessions();
      error(`Session "${sessionId}" not found.`);
      if (available.length > 0) {
        info('Available sessions:\n' + available.map((s) => `  ${s}`).join('\n'));
      } else {
        info('No saved sessions found.');
      }
      process.exit(1);
    }

    const resumeFrom = (startStage ?? 'qa') as import('./types/index.js').PipelineStage;
    info(`Resuming session ${sessionId} from stage: ${resumeFrom}`);
    info(`Original output dir: ${state.outputDir}\n`);

    try {
      await runPipeline('', { resumeState: state, startStage: resumeFrom });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Pipeline error: ${message}`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      process.exit(1);
    } finally {
      closeInput();
    }
    return;
  }

  // ── FRESH RUN ──────────────────────────────────────────────────────────────
  console.log('This system will guide you through building a complete software product using AI agents.\n');
  console.log('Lifecycle stages:');
  console.log('  0. Access Check      — confirm prerequisites before requirements gathering');
  console.log('  1. Intake Agent      — extracts your requirements (Claude Opus 4.7)');
  console.log('  2. Architect Agent   — designs the system + design review gate (Claude Opus 4.7)');
  console.log('  3. Builder Agent     — generates the full codebase (Claude Sonnet 4.6)');
  console.log('  4. Demo Checkpoint   — human review of the built structure before QA gates');
  console.log('  5. Static Analysis   — type-check/lint/dependency audit, run in a sandbox');
  console.log('  5. Code Reviewer     — audits against spec + static analysis (Claude Opus 4.7)');
  console.log('  5. Verifier Agent    — adversarial second pass on every reviewer finding');
  console.log('  5. Debugger Agent    — fixes confirmed issues (Claude Sonnet 4.6)');
  console.log('  6. QA Agent          — generates & runs 100-200 tests (OpenAI Codex)');
  console.log('  7. Delivery Agent    — packages everything for deploy (Claude Sonnet 4.6)');
  console.log('  8. Hypercare         — post-ship owner, monitoring window, handoff notes\n');
  console.log('Tip: to resume a previous session run:');
  console.log(
    '  node dist/index.js --resume=<sessionId> [--from=access_check|intake|architecture|building|demo_checkpoint|code_review|qa|delivery|hypercare]\n'
  );

  const goal = await askMultiline("What would you like to build? Describe it in as much detail as you'd like.");

  if (!goal.trim()) {
    error('No goal provided. Exiting.');
    closeInput();
    process.exit(1);
  }

  try {
    await runPipeline(goal);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    error(`Pipeline error: ${message}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    closeInput();
  }
}

main();
