import Anthropic from '@anthropic-ai/sdk';
import * as path from 'path';
import * as fs from 'fs-extra';
import { SessionState } from '../types/index';
import { section, success, header } from '../utils/cli';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a technical delivery lead. Given a complete SDLC session, you produce:
1. A human-readable deployment guide specific to the tech stack used
2. A concise change log summarizing what the debugger fixed
3. A QA summary with pass/fail statistics and notable test coverage

Be specific and actionable. The deployment guide must include every step to get the app running from scratch.`;

export async function runDeliveryAgent(state: SessionState): Promise<string> {
  section('Delivery Agent â€” Compiling final delivery package...');

  const debugSummary = state.history.debugRuns
    .map(
      (r) =>
        `Iteration ${r.iteration} (${r.source}): ${r.fixesApplied.length} fixes â€” ${r.fixesApplied.map((f) => f.description).join('; ')}`
    )
    .join('\n');

  const qaSummary = state.history.qaResults.map((r) => ({
    iteration: r.iteration,
    total: r.total,
    passed: r.passed,
    failed: r.failed,
    allPassed: r.allPassed,
  }));

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Architecture:\n${JSON.stringify(state.currentTruth.architecture, null, 2)}\n\nDebug runs:\n${debugSummary}\n\nQA results:\n${JSON.stringify(qaSummary, null, 2)}\n\nGenerate a deployment guide, change log, and QA summary. Format as Markdown.`,
      },
    ],
  });

  return (response.content[0] as { type: string; text: string }).text;
}

export async function writeDeliveryPackage(
  state: SessionState,
  deliveryNotes: string
): Promise<string> {
  const deliveryDir = path.join(state.outputDir, '_delivery');
  await fs.ensureDir(deliveryDir);

  // Architecture doc
  const archPath = path.join(deliveryDir, 'ARCHITECTURE.md');
  await fs.writeFile(archPath, state.currentTruth.architecture?.rawMarkdown ?? '', 'utf8');

  // Code review reports â€” include static analysis evidence and verifier verdicts,
  // not just the reviewer's own self-reported summary.
  const reviewPath = path.join(deliveryDir, 'CODE_REVIEW.md');
  const reviewContent = state.history.reviewReports
    .map((r) => {
      const analysisForIter = state.history.analysisReports.find((a) => a.iteration === r.iteration);
      const analysisSection = analysisForIter
        ? `### Static Analysis\n${analysisForIter.checks.map((c) => `- [${c.passed ? 'PASS' : 'FAIL'}] ${c.name}`).join('\n') || '(no applicable checks)'}`
        : '### Static Analysis\n(not recorded for this iteration)';
      const issuesSection = r.issues
        .map(
          (i) =>
            `- [${i.severity.toUpperCase()}] ${i.file}: ${i.description} â€” verdict: ${i.verdict ?? 'not verified'}${i.verdictReason ? ` (${i.verdictReason})` : ''}`
        )
        .join('\n');
      return `## Review Iteration ${r.iteration}\n\n**Summary:** ${r.summary}\n\n**Reviewer self-reported approved:** ${r.approved}\n**Verified approved:** ${r.verifiedApproved ?? 'not computed'}\n\n${analysisSection}\n\n### Issues Found\n${issuesSection}\n\n### Checks Passed\n${r.passedChecks.map((c) => `- ${c}`).join('\n')}`;
    })
    .join('\n\n---\n\n');
  await fs.writeFile(reviewPath, `# Code Review Report\n\n${reviewContent}`, 'utf8');

  // QA report
  const qaPath = path.join(deliveryDir, 'QA_REPORT.md');
  const qaContent = state.history.qaResults
    .map(
      (r) =>
        `## QA Iteration ${r.iteration}\n\n- Total Tests: ${r.total}\n- Passed: ${r.passed}\n- Failed: ${r.failed}\n- All Passed: ${r.allPassed}\n\n### Tests\n${r.tests.map((t) => `- [${t.status.toUpperCase()}] #${t.order} ${t.name} (${t.workflow})`).join('\n')}`
    )
    .join('\n\n---\n\n');
  await fs.writeFile(qaPath, `# QA Report\n\n${qaContent}`, 'utf8');

  // Deployment guide + change log
  const deployPath = path.join(deliveryDir, 'DEPLOYMENT.md');
  await fs.writeFile(deployPath, deliveryNotes, 'utf8');

  // Session manifest
  const manifestPath = path.join(deliveryDir, 'SESSION.json');
  await fs.writeJson(manifestPath, { sessionId: state.sessionId, createdAt: state.createdAt, stage: state.stage }, { spaces: 2 });

  return deliveryDir;
}

export async function writeHypercarePackage(state: SessionState, deliveryDir: string): Promise<string> {
  await fs.ensureDir(deliveryDir);
  const hypercarePath = path.join(deliveryDir, 'HYPERCARE.md');

  const content = `# Hypercare & Handoff

**Owner:** ${state.futureIntent.hypercareOwner ?? '(not recorded)'}
**Monitoring window:** ${state.futureIntent.hypercareWindow ?? '(not recorded)'}

## Handoff notes

${state.futureIntent.hypercareNotes || '(none recorded)'}

## Demo checkpoint notes carried into review

${state.futureIntent.demoCheckpointNotes || '(none recorded)'}
`;

  await fs.writeFile(hypercarePath, content, 'utf8');
  return hypercarePath;
}

export function printDeliverySummary(state: SessionState, deliveryDir: string): void {
  header('Delivery Complete');

  const lastQA = state.history.qaResults[state.history.qaResults.length - 1];
  const lastReview = state.history.reviewReports[state.history.reviewReports.length - 1];
  const fileCount = state.currentTruth.sourceCode?.files.length ?? 0;
  const debugCount = state.history.debugRuns.length;

  console.log(`  Session ID     : ${state.sessionId}`);
  console.log(`  Output Dir     : ${state.outputDir}`);
  console.log(`  Delivery Docs  : ${deliveryDir}`);
  console.log(`  Files Generated: ${fileCount}`);
  console.log(`  Debug Runs     : ${debugCount}`);
  console.log(`  Review Iters   : ${state.history.reviewReports.length}`);
  console.log(`  QA Tests       : ${lastQA?.total ?? 0} (${lastQA?.passed ?? 0} passed)`);
  console.log(`  Review Status  : ${lastReview?.verifiedApproved ? 'APPROVED (verified)' : 'N/A'}`);
  console.log(`  QA Status      : ${lastQA?.allPassed ? 'ALL PASSED' : 'INCOMPLETE'}`);
  console.log(`  Hypercare Owner: ${state.futureIntent.hypercareOwner ?? '(not recorded)'}`);
  console.log('');
  success('Your system is ready. See the _delivery/ folder for all documentation.');
}
