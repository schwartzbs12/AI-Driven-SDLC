import OpenAI from 'openai';
import * as path from 'path';
import * as childProcess from 'child_process';
import {
  ProductBrief,
  ArchitectureDocument,
  SourceCodeArtifact,
  QATest,
  QAResults,
  CodeFile,
} from '../types/index';
import { formatFilesForLLM, parseCodeFilesFromLLMOutput } from '../utils/files';
import { writeFile } from '../utils/files';
import { section, info, success, warn, error as cliError } from '../utils/cli';
import { v4 as uuidv4 } from 'uuid';
import { isDockerAvailable, inferDockerImage, runInSandbox } from '../utils/sandbox';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const QA_MODEL = process.env.QA_MODEL ?? 'gpt-5.4';

// Sentinel used to distinguish "dependencies never installed" from a real
// test failure, since the two must not be graded the same way downstream.
const INSTALL_FAILURE_MARKER = '__DEPENDENCY_INSTALL_FAILED__';

const SYSTEM_PROMPT = `You are an expert QA engineer using OpenAI Codex. You write comprehensive, executable test suites for software systems.

Your tests:
1. Cover every major workflow identified in the product brief and architecture
2. Are SUCCESSIVE â€” test N must pass before test N+1 can run (use beforeAll/setUp that depends on prior state)
3. Are 100-200 tests total, scaled to system complexity
4. Test happy paths, edge cases, error conditions, and security boundaries
5. Are real, runnable tests â€” not pseudocode
6. Use the same testing framework as the project (jest, pytest, go test, etc.)

Output format â€” wrap the test file(s) in XML tags:
<file path="relative/test/path.test.ext" language="lang">
test file contents
</file>

Then output a JSON test manifest wrapped in \`\`\`json ... \`\`\`:
[{
  "id": string,
  "order": number,
  "name": string,
  "workflow": string,
  "description": string,
  "testCode": "brief excerpt of what this test does"
}]`;

export async function runQAGenerationAgent(
  brief: ProductBrief,
  arch: ArchitectureDocument,
  artifact: SourceCodeArtifact,
  iteration: number
): Promise<{ testFiles: CodeFile[]; manifest: QATest[] }> {
  section(`QA Agent (Codex ${QA_MODEL}) â€” Generating test suite (iteration ${iteration})...`);

  const codeBlock = formatFilesForLLM(artifact.files);

  const prompt = `Product brief:\n${JSON.stringify(brief, null, 2)}\n\nArchitecture:\n${JSON.stringify(arch, null, 2)}\n\nCurrent codebase:\n\n${codeBlock}\n\nGenerate a comprehensive, successive test suite of 100-200 tests covering all major workflows. Tests must be real, runnable, and use ${arch.techStack.testingFramework}.`;

  let fullText = '';

  try {
    // codex-5,5 uses the responses API
    const response = await openai.responses.create({
      model: QA_MODEL,
      input: `${SYSTEM_PROMPT}\n\n${prompt}`,
    });
    fullText = response.output_text ?? '';
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Fallback to chat completions if responses API unavailable
    warn(`Responses API failed (${message}), falling back to chat completions...`);
    const chat = await openai.chat.completions.create({
      model: QA_MODEL,
      max_tokens: 16000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    });
    fullText = chat.choices[0]?.message?.content ?? '';
  }

  const testFiles = parseCodeFilesFromLLMOutput(fullText);

  const metaMatch = fullText.match(/```json\s*([\s\S]*?)```/);
  let manifest: QATest[] = [];

  if (metaMatch) {
    try {
      const parsed = JSON.parse(metaMatch[1]) as Omit<QATest, 'status'>[];
      manifest = parsed.map((t) => ({
        ...t,
        id: t.id || uuidv4(),
        status: 'pending' as const,
      }));
    } catch {
      // Build minimal manifest from test files
      manifest = testFiles.map((f, i) => ({
        id: uuidv4(),
        order: i + 1,
        name: path.basename(f.path),
        workflow: 'general',
        description: `Tests in ${f.path}`,
        testCode: f.content.slice(0, 200),
        status: 'pending' as const,
      }));
    }
  }

  info(`Generated ${testFiles.length} test file(s), ${manifest.length} test cases.`);
  return { testFiles, manifest };
}

export async function executeTests(
  outputDir: string,
  artifact: SourceCodeArtifact
): Promise<{ passed: boolean; output: string; failedTests: string[] }> {
  section('QA Agent â€” Installing dependencies and running test suite...');

  const sandboxed = isDockerAvailable();
  const image = inferDockerImage(artifact.installCommand, artifact.testCommand);

  if (sandboxed) {
    info(`Running in sandbox (docker image: ${image}). Install has network access; test execution does not.`);
  } else {
    warn(
      'Docker not available â€” running install/test commands directly on the host (unsandboxed). ' +
      'Install Docker to sandbox generated code execution.'
    );
  }

  const runStep = (command: string, timeoutMs: number, network: boolean): { success: boolean; output: string } => {
    if (sandboxed) {
      const result = runInSandbox(outputDir, command, image, timeoutMs, network);
      return { success: result.status === 'success', output: result.output };
    }
    try {
      const output = childProcess.execSync(command, {
        cwd: outputDir,
        timeout: timeoutMs,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { success: true, output };
    } catch (err: unknown) {
      const execError = err as { stdout?: string; stderr?: string; message?: string };
      const output = [execError.stdout ?? '', execError.stderr ?? '', execError.message ?? ''].join('\n');
      return { success: false, output };
    }
  };

  // Install needs the registry; the untrusted test/app code that runs after it does not.
  const install = runStep(artifact.installCommand, 300_000, true);
  if (!install.success) {
    warn('Dependency install failed â€” skipping test execution.');
    cliError(install.output.slice(0, 2000));
    return {
      passed: false,
      output: `Dependency install failed:\n${install.output}`,
      failedTests: [INSTALL_FAILURE_MARKER],
    };
  }

  const test = runStep(artifact.testCommand, 300_000, false);
  if (test.success) {
    success('All tests passed.');
    return { passed: true, output: test.output, failedTests: [] };
  }

  const failedTests = extractFailedTestNames(test.output);
  warn(`Tests failed. ${failedTests.length} failures detected.`);
  cliError(test.output.slice(0, 2000));
  return { passed: false, output: test.output, failedTests };
}

function extractFailedTestNames(output: string): string[] {
  const failures: string[] = [];

  // Jest pattern: â— Test name
  const jestMatches = output.matchAll(/â— (.+)/g);
  for (const m of jestMatches) failures.push(m[1].trim());

  // Pytest pattern: FAILED path::test_name
  const pytestMatches = output.matchAll(/FAILED\s+([^\s]+)/g);
  for (const m of pytestMatches) failures.push(m[1].trim());

  // Go test pattern: --- FAIL: TestName
  const goMatches = output.matchAll(/--- FAIL: (\w+)/g);
  for (const m of goMatches) failures.push(m[1].trim());

  return [...new Set(failures)];
}

export async function runQAIteration(
  brief: ProductBrief,
  arch: ArchitectureDocument,
  artifact: SourceCodeArtifact,
  outputDir: string,
  iteration: number
): Promise<QAResults> {
  const { testFiles, manifest } = await runQAGenerationAgent(brief, arch, artifact, iteration);

  // Write test files into the output project
  for (const f of testFiles) {
    await writeFile(outputDir, f);
  }

  // Run the tests
  const { passed, output, failedTests } = await executeTests(outputDir, artifact);

  // Mark test statuses
  const isInstallFailure = failedTests.includes(INSTALL_FAILURE_MARKER);

  const tests: QATest[] = manifest.map((t) => {
    if (passed) {
      return { ...t, status: 'passed' as const, error: undefined };
    }
    if (isInstallFailure) {
      return {
        ...t,
        status: 'failed' as const,
        error: `Dependency install failed before tests could run:\n${output.slice(0, 500)}`,
      };
    }
    const isFailed = failedTests.some(
      (name) => t.name.includes(name) || name.includes(t.name)
    );
    return {
      ...t,
      status: isFailed ? ('failed' as const) : ('passed' as const),
      error: isFailed ? `Test runner reported failure. Output:\n${output.slice(0, 500)}` : undefined,
    };
  });

  const passedCount = tests.filter((t) => t.status === 'passed').length;
  const failedCount = tests.filter((t) => t.status === 'failed').length;

  return {
    iteration,
    tests,
    passed: passedCount,
    failed: failedCount,
    total: tests.length,
    allPassed: passed,
  };
}
