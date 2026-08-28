import Anthropic from '@anthropic-ai/sdk';
import { CodeFile, ReviewIssue, SourceCodeArtifact } from '../types/index';
import { section, info, warn } from '../utils/cli';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a skeptical, adversarial second reviewer. You are given a single issue that another reviewer claimed to find in a specific file, plus that file's content.

Your only job: decide whether the claimed issue is REAL and whether the suggested fix actually makes sense, or whether the original reviewer was wrong, imprecise, or hallucinated something that isn't there.

Be strict. If the file doesn't contain the described problem, or the described problem does not actually cause incorrect behavior, mark it unconfirmed. Do not be persuaded by the original reviewer's confidence â€” read the code yourself.

Return ONLY valid JSON:
{
  "verdict": "confirmed" | "unconfirmed",
  "reason": string
}`;

function findFile(artifact: SourceCodeArtifact, filePath: string): CodeFile | undefined {
  return artifact.files.find((f) => f.path === filePath);
}

async function verifyOne(issue: ReviewIssue, artifact: SourceCodeArtifact): Promise<ReviewIssue> {
  const file = findFile(artifact, issue.file);
  const fileContext = file
    ? `File: ${file.path}\n\n${file.content}`
    : `File "${issue.file}" was not found in the current codebase â€” treat that itself as strong evidence toward "unconfirmed".`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Claimed issue:\n${JSON.stringify(
            {
              severity: issue.severity,
              file: issue.file,
              line: issue.line,
              description: issue.description,
              suggestion: issue.suggestion,
              category: issue.category,
            },
            null,
            2
          )}\n\n${fileContext}\n\nIs this issue real? Return the JSON verdict.`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === 'text') as { type: string; text: string } | undefined;
    const raw = textBlock?.text ?? '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      warn(`Verifier could not parse a verdict for issue ${issue.id} â€” treating as inconclusive (fail closed on ambiguity).`);
      return { ...issue, verdict: 'inconclusive', verdictReason: 'Verifier response was unparseable.' };
    }

    const parsed = JSON.parse(jsonMatch[0]) as { verdict: 'confirmed' | 'unconfirmed'; reason: string };
    if (parsed.verdict !== 'confirmed' && parsed.verdict !== 'unconfirmed') {
      return { ...issue, verdict: 'inconclusive', verdictReason: 'Verifier returned an unrecognized verdict value.' };
    }
    return { ...issue, verdict: parsed.verdict, verdictReason: parsed.reason };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`Verifier call failed for issue ${issue.id} (${message}) â€” treating as inconclusive (fail closed).`);
    return { ...issue, verdict: 'inconclusive', verdictReason: `Verifier call failed: ${message}` };
  }
}

// Runs a second, independent, adversarial pass over each Reviewer finding
// before it's allowed to count toward blocking. Catches the Reviewer
// hallucinating or misreading an issue, not just missing one.
//
// Gating contract (see ReviewIssue.verdict): only an explicit "unconfirmed"
// â€” the verifier actively checked and disagrees â€” suppresses a finding.
// A failed/unparseable verification is "inconclusive," which fails closed
// and still blocks, same as "confirmed." This way the verify pass can only
// ever remove a false positive it's actually sure about; it can never
// silently drop a finding just because the check itself broke.
export async function verifyReviewIssues(
  issues: ReviewIssue[],
  artifact: SourceCodeArtifact
): Promise<ReviewIssue[]> {
  if (issues.length === 0) return issues;

  section(`Verifier Agent â€” Checking ${issues.length} reported issue(s)...`);

  const verified = await Promise.all(issues.map((issue) => verifyOne(issue, artifact)));

  const confirmedCount = verified.filter((i) => i.verdict === 'confirmed').length;
  const unconfirmedCount = verified.filter((i) => i.verdict === 'unconfirmed').length;
  const inconclusiveCount = verified.filter((i) => i.verdict === 'inconclusive').length;
  info(`Verification complete: ${confirmedCount} confirmed, ${unconfirmedCount} unconfirmed, ${inconclusiveCount} inconclusive.`);

  return verified;
}
