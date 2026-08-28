import * as path from 'path';
import * as fs from 'fs-extra';
import { SessionState, PipelineStage } from '../types/index';
import { createSession, saveSession, advanceStage } from '../utils/state';
import { writeSourceCode, getDirectoryStructure } from '../utils/files';
import { runStaticAnalysis } from '../utils/analysis';
import { commitStage } from '../utils/git';
import { header, success, warn, info, awaitApproval, ask, askMultiline } from '../utils/cli';
import { runIntakeFlow } from '../agents/intake';
import { runArchitectAgent } from '../agents/architect';
import { runBuilderAgent } from '../agents/builder';
import { runReviewerAgent } from '../agents/reviewer';
import { verifyReviewIssues } from '../agents/verifier';
import { runDebuggerAgent } from '../agents/debugger';
import { runQAIteration } from '../agents/qa';
import {
  runDeliveryAgent,
  writeDeliveryPackage,
  writeHypercarePackage,
  printDeliverySummary,
} from '../agents/delivery';

const MAX_REVIEW_ITERATIONS = parseInt(process.env.MAX_REVIEW_ITERATIONS ?? '5', 10);
const MAX_QA_ITERATIONS = parseInt(process.env.MAX_QA_ITERATIONS ?? '5', 10);

const stageOrder: PipelineStage[] = [
  'access_check',
  'intake',
  'architecture',
  'architecture_approval',
  'building',
  'demo_checkpoint',
  'code_review',
  'debugging_review',
  'qa',
  'debugging_qa',
  'delivery',
  'hypercare',
  'complete',
];

interface PipelineOptions {
  resumeState?: SessionState;
  startStage?: PipelineStage;
}

export async function runPipeline(userGoal: string, options: PipelineOptions = {}): Promise<void> {
  const { resumeState, startStage } = options;

  let state: SessionState;
  let outputDir: string;

  if (resumeState) {
    state = resumeState;
    outputDir = resumeState.outputDir;
    await fs.ensureDir(outputDir);
  } else {
    outputDir = path.resolve(process.cwd(), 'output', `session-${Date.now()}`);
    await fs.ensureDir(outputDir);
    state = await createSession(outputDir);
  }

  header('SDLC Agent System');
  info(`Session ID: ${state.sessionId}`);
  info(`Output:     ${outputDir}\n`);

  const skip = (stage: PipelineStage): boolean =>
    !!startStage && stageOrder.indexOf(stage) < stageOrder.indexOf(startStage);

  // â”€â”€ STAGE 0: ACCESS CHECK (Requirements and Access) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!skip('access_check')) {
    advanceStage(state, 'access_check');
    await saveSession(state);

    header('Stage 0 â€” Access & Readiness Check');
    let accessConfirmed = false;
    while (!accessConfirmed) {
      console.log('Before requirements gathering begins, confirm the following are in place:');
      console.log('  - ANTHROPIC_API_KEY / OPENAI_API_KEY are set (already validated at startup)');
      console.log('  - You have write access to the output directory for this session');
      console.log('  - Any deployment/target environment credentials you will need later are available\n');
      accessConfirmed = await awaitApproval('Confirm access and prerequisites are ready to proceed?');
      if (!accessConfirmed) {
        info("Take care of what's missing, then confirm again when ready.");
      }
    }
    success('Access confirmed.');
  }

  // â”€â”€ STAGE 1: INTAKE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!skip('intake')) {
    advanceStage(state, 'intake');
    await saveSession(state);

    header('Stage 1 â€” Intake');
    state.currentTruth.productBrief = await runIntakeFlow(userGoal);
    await saveSession(state);
    success('Product brief complete.');
  }

  // â”€â”€ STAGE 2: ARCHITECTURE (with approval loop / Design Review) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!skip('architecture')) {
    advanceStage(state, 'architecture');
    await saveSession(state);

    header('Stage 2 â€” Architecture & Design Review');
    let architectureApproved = false;

    while (!architectureApproved) {
      state.currentTruth.architecture = await runArchitectAgent(
        state.currentTruth.productBrief!,
        state.futureIntent.architectureRevisionNotes
      );
      await saveSession(state);

      console.log('\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â” ARCHITECTURE DOCUMENT â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n');
      console.log(state.currentTruth.architecture.rawMarkdown);
      console.log('\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n');

      advanceStage(state, 'architecture_approval');
      architectureApproved = await awaitApproval('Do you approve this architecture (design review)?');

      if (!architectureApproved) {
        state.futureIntent.architectureRevisionNotes = await ask('What would you like to change or add?');
        advanceStage(state, 'architecture');
      }
    }

    // Approved: the revision request is realized now, not still-pending intent.
    state.futureIntent.architectureRevisionNotes = undefined;
    await saveSession(state);
    success('Architecture approved. Proceeding to build.');
  }

  // â”€â”€ STAGE 3: BUILD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!skip('building')) {
    advanceStage(state, 'building');
    await saveSession(state);

    header('Stage 3 â€” Build');
    state.currentTruth.sourceCode = await runBuilderAgent(
      state.currentTruth.productBrief!,
      state.currentTruth.architecture!
    );
    await writeSourceCode(outputDir, state.currentTruth.sourceCode);
    await saveSession(state);
    await commitStage(outputDir, 'Initial build from Architect + Builder agents');

    const structure = await getDirectoryStructure(outputDir);
    info('Generated project structure:\n' + structure);
    success(`Build complete. ${state.currentTruth.sourceCode.files.length} files written to ${outputDir}`);
  }

  // â”€â”€ STAGE 3.5: DEMO CHECKPOINT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!skip('demo_checkpoint')) {
    advanceStage(state, 'demo_checkpoint');
    await saveSession(state);

    header('Stage 4 â€” Demo Checkpoint');
    const structure = await getDirectoryStructure(outputDir);
    console.log('Generated project structure:\n' + structure);
    info(`Entry point: ${state.currentTruth.sourceCode?.entryPoint}`);
    info(`Install:     ${state.currentTruth.sourceCode?.installCommand}`);
    info(`Test:        ${state.currentTruth.sourceCode?.testCommand}`);

    const demoApproved = await awaitApproval(
      'Take a look at the generated structure above. Ready to proceed to review & QA?'
    );
    if (!demoApproved) {
      state.futureIntent.demoCheckpointNotes = await ask(
        'What should the review/QA stages pay special attention to?'
      );
      warn('Notes recorded and will be surfaced to the reviewer. Proceeding â€” this checkpoint does not trigger a rebuild.');
    }
    await saveSession(state);
    success('Demo checkpoint complete.');
  }

  // â”€â”€ STAGE 4: STATIC ANALYSIS + CODE REVIEW + VERIFY + DEBUG LOOP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!skip('code_review')) {
    advanceStage(state, 'code_review');
    await saveSession(state);

    header('Stage 5 â€” Static Analysis, Code Review & Debug Loop');
    let reviewIteration = 1;
    let reviewApproved = false;

    while (!reviewApproved && reviewIteration <= MAX_REVIEW_ITERATIONS) {
      const analysisReport = await runStaticAnalysis(
        outputDir,
        state.currentTruth.sourceCode!,
        reviewIteration
      );
      state.history.analysisReports.push(analysisReport);
      await saveSession(state);

      const report = await runReviewerAgent(
        state.currentTruth.productBrief!,
        state.currentTruth.architecture!,
        state.currentTruth.sourceCode!,
        reviewIteration,
        analysisReport,
        state.futureIntent.demoCheckpointNotes
      );

      report.issues = await verifyReviewIssues(report.issues, state.currentTruth.sourceCode!);

      const blockingIssues = report.issues.filter(
        (i) => (i.severity === 'critical' || i.severity === 'high') && i.verdict !== 'unconfirmed'
      );
      report.verifiedApproved = blockingIssues.length === 0;

      state.history.reviewReports.push(report);
      await saveSession(state);

      if (report.verifiedApproved) {
        reviewApproved = true;
        success('Code review passed (verified).');
      } else {
        advanceStage(state, 'debugging_review');

        const debugRun = await runDebuggerAgent(
          state.currentTruth.architecture!,
          state.currentTruth.sourceCode!,
          blockingIssues,
          [],
          'review',
          reviewIteration
        );
        state.history.debugRuns.push(debugRun);

        await writeSourceCode(outputDir, state.currentTruth.sourceCode!);
        await saveSession(state);
        await commitStage(outputDir, `Fix review issues (iteration ${reviewIteration})`);

        advanceStage(state, 'code_review');
        reviewIteration++;
      }
    }

    if (!reviewApproved) {
      warn(`Reached max review iterations (${MAX_REVIEW_ITERATIONS}). Proceeding with current state.`);
    }
  }

  // â”€â”€ STAGE 5: QA + DEBUG LOOP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!skip('qa')) {
    advanceStage(state, 'qa');
    await saveSession(state);

    header('Stage 6 â€” QA (OpenAI Codex)');
    let qaIteration = 1;
    let qaAllPassed = false;

    while (!qaAllPassed && qaIteration <= MAX_QA_ITERATIONS) {
      const qaResults = await runQAIteration(
        state.currentTruth.productBrief!,
        state.currentTruth.architecture!,
        state.currentTruth.sourceCode!,
        outputDir,
        qaIteration
      );
      state.history.qaResults.push(qaResults);
      await saveSession(state);

      if (qaResults.allPassed) {
        qaAllPassed = true;
        success(`All ${qaResults.total} QA tests passed.`);
      } else {
        const failedTests = qaResults.tests.filter((t) => t.status === 'failed');
        warn(`${failedTests.length} test(s) failed. Sending to Debugger.`);

        advanceStage(state, 'debugging_qa');

        const debugRun = await runDebuggerAgent(
          state.currentTruth.architecture!,
          state.currentTruth.sourceCode!,
          [],
          failedTests,
          'qa',
          qaIteration
        );
        state.history.debugRuns.push(debugRun);

        await writeSourceCode(outputDir, state.currentTruth.sourceCode!);
        await saveSession(state);
        await commitStage(outputDir, `Fix QA failures (iteration ${qaIteration})`);

        advanceStage(state, 'qa');
        qaIteration++;
      }
    }

    // Catches the final iteration's generated test files even when no debug
    // fix followed it (e.g. QA passed on the first try).
    await commitStage(outputDir, 'QA test suite');

    if (!qaAllPassed) {
      warn(`Reached max QA iterations (${MAX_QA_ITERATIONS}). Proceeding with current state.`);
    }
  }

  // â”€â”€ STAGE 6: DELIVERY (Ship) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let deliveryDir = '';
  if (!skip('delivery')) {
    advanceStage(state, 'delivery');
    await saveSession(state);

    header('Stage 7 â€” Delivery');
    const deliveryNotes = await runDeliveryAgent(state);
    deliveryDir = await writeDeliveryPackage(state, deliveryNotes);
    await saveSession(state);
    await commitStage(outputDir, 'Delivery package: architecture, code review, QA report, deployment guide');
  }

  // â”€â”€ STAGE 7: HYPERCARE & HANDOFF â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!skip('hypercare')) {
    advanceStage(state, 'hypercare');
    await saveSession(state);

    header('Stage 8 â€” Hypercare & Handoff');
    state.futureIntent.hypercareOwner = await ask('Who is the hypercare owner for this delivery (name/team)?');
    state.futureIntent.hypercareWindow = await ask(
      'What is the hypercare monitoring window (e.g., "72 hours post-ship")?'
    );
    state.futureIntent.hypercareNotes = await askMultiline(
      'Any handoff notes, known risks, or follow-ups for the hypercare owner?'
    );

    if (!deliveryDir) {
      deliveryDir = path.join(outputDir, '_delivery');
    }
    await writeHypercarePackage(state, deliveryDir);
    await saveSession(state);
    await commitStage(outputDir, 'Hypercare handoff notes');
    success('Hypercare handoff notes recorded.');
  }

  advanceStage(state, 'complete');
  await saveSession(state);

  if (deliveryDir) {
    printDeliverySummary(state, deliveryDir);
  }
}
