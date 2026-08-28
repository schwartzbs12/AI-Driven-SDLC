import Anthropic from '@anthropic-ai/sdk';
import { ProductBrief, ArchitectureDocument } from '../types/index';
import { section, info } from '../utils/cli';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a principal software architect. Given a product brief, you design complete, production-grade system architectures.

Your architectures include:
- A clear technical overview
- Specific tech stack choices with justification
- All system components with responsibilities and dependencies
- Data models and schema definitions
- API contracts (endpoints, request/response shapes)
- Edge cases and how the architecture handles them
- Security considerations
- An ASCII architecture diagram

You output a structured JSON ArchitectureDocument followed by a human-readable Markdown summary.
Be specific â€” name actual frameworks, libraries, and file paths. Do not be vague.`;

function extractJsonBlock(text: string): string | null {
  const markerIdx = text.indexOf('```json');
  const searchFrom = markerIdx !== -1 ? markerIdx + 7 : 0;
  const start = text.indexOf('{', searchFrom);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

export async function runArchitectAgent(
  brief: ProductBrief,
  revisionNotes?: string
): Promise<ArchitectureDocument> {
  section('Architect Agent â€” Designing system architecture...');

  const revisionBlock = revisionNotes
    ? `\n\nUser revision notes:\n${revisionNotes}\n\nPlease update the architecture accordingly.`
    : '';

  const response = await anthropic.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 64000,
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
        content: `Product brief:\n${JSON.stringify(brief, null, 2)}${revisionBlock}\n\nDesign the complete system architecture. Return the response in TWO parts:\n\n1. A JSON block (wrapped in \`\`\`json ... \`\`\`) matching exactly this structure:\n{\n  "overview": string,\n  "techStack": {\n    "language": string,\n    "framework": string,\n    "database": string | undefined,\n    "testingFramework": string,\n    "packageManager": string,\n    "additionalLibraries": string[]\n  },\n  "components": [{\n    "name": string,\n    "type": string,\n    "responsibility": string,\n    "dependencies": string[],\n    "filePath": string\n  }],\n  "dataModels": string,\n  "apiContracts": string,\n  "edgeCases": string[],\n  "securityConsiderations": string,\n  "diagram": string\n}\n\n2. A Markdown summary (wrapped in \`\`\`markdown ... \`\`\`) that is human-readable and suitable for user review.`,
      },
    ],
  }).finalMessage();

  const textBlock = response.content.find((block) => block.type === 'text') as { type: string; text: string } | undefined;
  const raw = textBlock?.text ?? '';

  const markdownMatch = raw.match(/```markdown\s*([\s\S]*?)```/);
  const jsonStr = extractJsonBlock(raw);
  if (!jsonStr) throw new Error('Architect Agent did not return valid JSON block');

  const doc = JSON.parse(jsonStr) as ArchitectureDocument;
  doc.rawMarkdown = markdownMatch ? markdownMatch[1] : raw;

  info('Architecture document complete.');
  return doc;
}
