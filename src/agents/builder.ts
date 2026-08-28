import Anthropic from '@anthropic-ai/sdk';
import { ProductBrief, ArchitectureDocument, SourceCodeArtifact } from '../types/index';
import { parseCodeFilesFromLLMOutput } from '../utils/files';
import { section, info } from '../utils/cli';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a senior full-stack engineer. Given a product brief and architecture document, you generate a complete, production-ready codebase.

Rules:
- Generate ALL files needed for the system to run â€” no stubs, no TODOs, no placeholders.
- Every file must have complete, working implementation code.
- Include package.json / requirements.txt / go.mod (whatever is appropriate) with all dependencies pinned.
- Include a test runner configuration (jest.config.js, pytest.ini, etc.) so tests can be executed with a single command.
- Include a .env.example with all required environment variables documented.
- Follow the architecture spec exactly â€” use the specified components, file paths, and tech stack.
- Write clean, idiomatic code with proper error handling.

Output format — wrap EVERY file in XML tags exactly like this:
<file path="relative/path/to/file.ext" language="typescript">
file contents here
</file>

After all files, output a JSON metadata block wrapped in \`\`\`json ... \`\`\`:
{
  "entryPoint": "src/index.ts",
  "testCommand": "npm test",
  "installCommand": "npm install",
  "structure": "brief description of the project structure"
}`;

export async function runBuilderAgent(
  brief: ProductBrief,
  arch: ArchitectureDocument
): Promise<SourceCodeArtifact> {
  section('Builder Agent — Generating full codebase...');
  console.log('  This may take a few minutes for large systems...\n');

  let fullText = '';

  const stream = anthropic.messages.stream({
    model: 'claude-opus-4-7',
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
        content: [
          {
            type: 'text',
            text: `Product brief:\n${JSON.stringify(brief, null, 2)}`,
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: `Architecture document:\n${JSON.stringify(arch, null, 2)}\n\nGenerate the complete production codebase now.`,
          },
        ],
      },
    ],
  });

  process.stdout.write('  Generating');
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

  const files = parseCodeFilesFromLLMOutput(fullText);
  if (files.length === 0) {
    throw new Error('Builder Agent produced no parseable file blocks');
  }

  const metaMatch = fullText.match(/```json\s*([\s\S]*?)```/);
  let meta = {
    entryPoint: 'src/index.ts',
    testCommand: 'npm test',
    installCommand: 'npm install',
    structure: `${files.length} files generated`,
  };

  if (metaMatch) {
    try {
      meta = { ...meta, ...JSON.parse(metaMatch[1]) };
    } catch {
      // use defaults
    }
  }

  info(`Generated ${files.length} files.`);

  return {
    files,
    entryPoint: meta.entryPoint,
    testCommand: meta.testCommand,
    installCommand: meta.installCommand,
    structure: meta.structure,
  };
}
