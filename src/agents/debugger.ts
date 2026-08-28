import Anthropic from '@anthropic-ai/sdk';
import {
  ArchitectureDocument,
  SourceCodeArtifact,
  ReviewIssue,
  QATest,
  DebugRun,
  CodeFile,
  Fix,
} from '../types/index';
import { formatFilesForLLM, parseCodeFilesFromLLMOutput } from '../utils/files';
import { section, info, success } from '../utils/cli';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an expert debugging engineer. You receive a codebase along with a list of issues (either from a code review or a failed QA test) and produce corrected files.

Rules:
- Fix ONLY the reported issues. Do not refactor unrelated code.
- Return the complete corrected content for every file you touch â€” no diffs, no partial files.
- If a fix in one file requires changes to another, include both files.
- Explain each fix briefly in the Fix metadata.

Output format â€” wrap EVERY modified file in XML tags:
<file path="relative/path/to/file.ext" language="lang">
corrected file contents
</file>

Then output a JSON fixes block wrapped in \`\`\`json ... \`\`\`:
[{
  "issueId": string,
  "file": string,
  "description": string
}]`;

export async function runDebuggerAgent(
  arch: ArchitectureDocument,
  artifact: SourceCodeArtifact,
  issues: ReviewIssue[],
  failedTests: QATest[],
  source: 'review' | 'qa',
  iteration: number
): Promise<DebugRun> {
  section(`Debugger Agent â€” Fixing ${issues.length + failedTests.length} issues (source: ${source}, iteration ${iteration})...`);

  const issuesSummary =
    issues.length > 0
      ? `Code review issues:\n${JSON.stringify(issues, null, 2)}`
      : '';

  const testFailuresSummary =
    failedTests.length > 0
      ? `Failed QA tests:\n${failedTests
        .map((t) => `Test "${t.name}" (${t.workflow}): ${t.error ?? 'unknown error'}\nTest code:\n${t.testCode}`)
        .join('\n\n')}`
      : '';

  const codeBlock = formatFilesForLLM(artifact.files);

  let fullText = '';

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 12000,
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
              text: `Architecture:\n${JSON.stringify(arch, null, 2)}`,
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: `Current codebase:\n\n${codeBlock}`,
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: `Issues to fix:\n\n${issuesSummary}\n\n${testFailuresSummary}\n\nFix all issues and return the corrected files.`,
            },
          ],
        },
      ],
    });

    process.stdout.write('  Fixing');
    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        fullText += event.delta.text;
        process.stdout.write('.');
      }
    }
    console.log(' done.\n');
  } catch (err) {
    console.log(' (stream interrupted, falling back to non-streaming call...)\n');
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 12000,
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
              text: `Architecture:\n${JSON.stringify(arch, null, 2)}`,
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: `Current codebase:\n\n${codeBlock}`,
              cache_control: { type: 'ephemeral' },
            },
            {
              type: 'text',
              text: `Issues to fix:\n\n${issuesSummary}\n\n${testFailuresSummary}\n\nFix all issues and return the corrected files.`,
            },
          ],
        },
      ],
    });
    const textBlock = response.content.find((block) => block.type === 'text') as { type: string; text: string } | undefined;
    fullText = textBlock?.text ?? '';
  }

  const updatedFiles = parseCodeFilesFromLLMOutput(fullText);

  const metaMatch = fullText.match(/```json\s*([\s\S]*?)```/);
  let fixes: Fix[] = [];
  if (metaMatch) {
    try {
      fixes = JSON.parse(metaMatch[1]) as Fix[];
    } catch {
      fixes = updatedFiles.map((f) => ({
        issueId: 'unknown',
        file: f.path,
        description: 'Fixed as part of debug run',
      }));
    }
  }

  // Merge updated files back into artifact
  applyFixesToArtifact(artifact, updatedFiles);

  success(`Applied ${updatedFiles.length} file updates.`);
  info(`Files changed: ${updatedFiles.map((f) => f.path).join(', ')}`);

  return {
    iteration,
    source,
    issueCount: issues.length + failedTests.length,
    fixesApplied: fixes,
    updatedFiles,
    timestamp: new Date().toISOString(),
  };
}

function applyFixesToArtifact(artifact: SourceCodeArtifact, updatedFiles: CodeFile[]): void {
  for (const updated of updatedFiles) {
    const idx = artifact.files.findIndex((f) => f.path === updated.path);
    if (idx >= 0) {
      artifact.files[idx] = updated;
    } else {
      artifact.files.push(updated);
    }
  }
}
