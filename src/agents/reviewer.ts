import Anthropic from '@anthropic-ai/sdk';
import {
  ProductBrief,
  ArchitectureDocument,
  SourceCodeArtifact,
  ReviewReport,
  ReviewIssue,
  AnalysisReport,
} from '../types/index';
import { formatFilesForLLM } from '../utils/files';
import { formatAnalysisForLLM } from '../utils/analysis';
import { section, info, success, warn } from '../utils/cli';
import { v4 as uuidv4 } from 'uuid';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a principal engineer conducting a thorough code review. You review code against:
1. The original product requirements (ProductBrief)
2. The agreed architecture (ArchitectureDocument)
3. General engineering best practices: correctness, security, performance, maintainability
4. Static analysis results (type-checker, linter, dependency audit) provided to you as evidence

Treat the static analysis section as ground truth, not opinion â€” if a tool reports a failure, don't second-guess it away, but do use your judgment on severity and whether it's actually reachable/exploitable. Don't re-derive issues the static analysis already reported verbatim; cite them and add your own reasoning (impact, fix) instead of restating them as if you found them independently.

For each issue found, you produce a structured ReviewIssue with:
- A unique id
- Severity: critical | high | medium | low
- File path
- Optional line number
- Clear description of the problem
- Concrete suggestion for fixing it
- Category: bug | security | architecture | performance | style

You also list checks that PASSED so the debugger knows what not to change.
You approve the code (approved: true) only when there are zero critical or high issues remaining.`;

async function attemptReview(
  brief: ProductBrief,
  arch: ArchitectureDocument,
  codeBlock: string,
  analysisBlock: string,
  demoNotes: string | undefined,
  iteration: number
): Promise<Omit<ReviewReport, 'iteration'> | null> {
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 8192,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Product brief:\n${JSON.stringify(brief, null, 2)}\n\nArchitecture:\n${JSON.stringify(arch, null, 2)}`,
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: `Static analysis results (iteration ${iteration}):\n\n${analysisBlock}`,
          },
          ...(demoNotes
            ? [
                {
                  type: 'text' as const,
                  text: `Notes from the human demo checkpoint â€” pay particular attention to these when reviewing:\n${demoNotes}`,
                },
              ]
            : []),
          {
            type: 'text',
            text: `Codebase (iteration ${iteration}):\n\n${codeBlock}\n\nConduct a thorough code review. Return ONLY valid JSON matching:\n{\n  "issues": [{\n    "id": string,\n    "severity": "critical"|"high"|"medium"|"low",\n    "file": string,\n    "line": number | undefined,\n    "description": string,\n    "suggestion": string,\n    "category": "bug"|"security"|"architecture"|"performance"|"style"\n  }],\n  "passedChecks": string[],\n  "summary": string,\n  "approved": boolean\n}`,
          },
        ],
      },
    ],
  });

  if (response.stop_reason === 'max_tokens') {
    return null;
  }

  const textBlock = response.content.find((b) => b.type === 'text') as { type: string; text: string } | undefined;
  const raw = textBlock?.text ?? '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  try {
    return JSON.parse(jsonMatch[0]) as Omit<ReviewReport, 'iteration'>;
  } catch {
    return null;
  }
}

export async function runReviewerAgent(
  brief: ProductBrief,
  arch: ArchitectureDocument,
  artifact: SourceCodeArtifact,
  iteration: number,
  analysis?: AnalysisReport,
  demoNotes?: string
): Promise<ReviewReport> {
  section(`Code Review Agent â€” Iteration ${iteration}...`);

  const codeBlock = formatFilesForLLM(artifact.files);
  const analysisBlock = analysis ? formatAnalysisForLLM(analysis) : 'Static analysis was not run for this iteration.';

  let result = await attemptReview(brief, arch, codeBlock, analysisBlock, demoNotes, iteration);

  if (!result) {
    warn('Reviewer Agent response was truncated or invalid on the first attempt â€” retrying once...');
    result = await attemptReview(brief, arch, codeBlock, analysisBlock, demoNotes, iteration);
  }

  if (!result) {
    warn('Reviewer Agent failed twice (truncated or invalid JSON) â€” failing closed. Blocking on a manual-review issue instead of auto-approving.');
    const failClosedIssue: ReviewIssue = {
      id: uuidv4(),
      severity: 'critical',
      file: '(pipeline)',
      description: 'Automated code review could not be completed: the reviewer response was truncated or malformed on both attempts.',
      suggestion: 'Manually review this codebase before proceeding, or re-run the review stage.',
      category: 'architecture',
    };
    return {
      issues: [failClosedIssue],
      passedChecks: [],
      summary: 'Review failed closed: could not obtain a valid review response after retry.',
      approved: false,
      iteration,
    };
  }

  // Ensure all issues have UUIDs
  result.issues = result.issues.map((issue: ReviewIssue) => ({
    ...issue,
    id: issue.id || uuidv4(),
  }));

  const report: ReviewReport = { ...result, iteration };

  const criticalCount = report.issues.filter((i) => i.severity === 'critical').length;
  const highCount = report.issues.filter((i) => i.severity === 'high').length;

  if (report.approved) {
    success(`Review passed â€” ${report.issues.length} minor issues, approved.`);
  } else {
    warn(
      `Review found ${report.issues.length} issues (${criticalCount} critical, ${highCount} high). Sending to Debugger.`
    );
  }

  return report;
}
