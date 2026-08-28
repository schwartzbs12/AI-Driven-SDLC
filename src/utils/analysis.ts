import { AnalysisCheck, AnalysisReport, SourceCodeArtifact } from '../types/index';
import { isDockerAvailable, inferDockerImage, runInSandbox } from './sandbox';
import { section, info, warn } from './cli';
import * as childProcess from 'child_process';

interface CheckSpec {
  name: string;
  applicable: boolean;
  command: string;
  // Type-checkers/linters/vet only need the toolchain already on disk after
  // install; audits need to reach a registry/advisory database regardless.
  needsNetwork: boolean;
}

function detectStack(artifact: SourceCodeArtifact): {
  node: boolean;
  typescript: boolean;
  python: boolean;
  go: boolean;
} {
  const paths = artifact.files.map((f) => f.path.toLowerCase());
  return {
    node: paths.some((p) => p.endsWith('package.json')),
    typescript: paths.some((p) => p.endsWith('tsconfig.json')) || paths.some((p) => p.endsWith('.ts') || p.endsWith('.tsx')),
    python: paths.some((p) => p.endsWith('requirements.txt') || p.endsWith('pyproject.toml')),
    go: paths.some((p) => p.endsWith('go.mod')),
  };
}

function buildCheckSpecs(artifact: SourceCodeArtifact): CheckSpec[] {
  const stack = detectStack(artifact);

  return [
    {
      name: 'typescript-typecheck',
      applicable: stack.node && stack.typescript,
      command: 'npx --yes tsc --noEmit',
      needsNetwork: false,
    },
    {
      name: 'eslint',
      applicable: stack.node,
      command: 'npx --yes eslint . --ext .js,.jsx,.ts,.tsx --max-warnings=-1',
      needsNetwork: false,
    },
    {
      name: 'npm-audit',
      applicable: stack.node,
      command: 'npm audit --audit-level=high',
      needsNetwork: true,
    },
    {
      name: 'python-compile',
      applicable: stack.python,
      command: 'python -m compileall -q .',
      needsNetwork: false,
    },
    {
      name: 'pip-audit',
      applicable: stack.python,
      command: 'pip install -q pip-audit && pip-audit -r requirements.txt',
      needsNetwork: true,
    },
    {
      name: 'go-vet',
      applicable: stack.go,
      command: 'go vet ./...',
      needsNetwork: false,
    },
  ];
}

function runHostCommand(outputDir: string, command: string, timeoutMs: number): { passed: boolean; output: string } {
  try {
    const output = childProcess.execSync(command, {
      cwd: outputDir,
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { passed: true, output };
  } catch (err: unknown) {
    const execError = err as { stdout?: string; stderr?: string; message?: string };
    const output = [execError.stdout ?? '', execError.stderr ?? '', execError.message ?? ''].join('\n');
    return { passed: false, output };
  }
}

function runStep(
  outputDir: string,
  command: string,
  sandboxed: boolean,
  image: string,
  timeoutMs: number,
  network: boolean
): { passed: boolean; output: string } {
  if (sandboxed) {
    const result = runInSandbox(outputDir, command, image, timeoutMs, network);
    return { passed: result.status === 'success', output: result.output };
  }
  return runHostCommand(outputDir, command, timeoutMs);
}

// Runs a small set of static-analysis tools (type-check, lint, dependency
// audit) as machine-checkable evidence, feeding the Reviewer facts instead
// of asking it to simulate all of this from reading source text.
//
// This installs dependencies itself (network on) before running checks,
// since it runs in the code_review stage â€” before the QA stage's own
// install step has ever executed. Once installed, the actual checks run
// with the same network-off boundary as test execution, except audits,
// which need registry access to check advisories.
export async function runStaticAnalysis(
  outputDir: string,
  artifact: SourceCodeArtifact,
  iteration: number
): Promise<AnalysisReport> {
  section(`Static Analysis â€” Iteration ${iteration}...`);

  const sandboxed = isDockerAvailable();
  const image = inferDockerImage(artifact.installCommand, artifact.testCommand);
  const specs = buildCheckSpecs(artifact).filter((s) => s.applicable);

  if (specs.length === 0) {
    info('No applicable static analysis checks for this stack â€” skipping.');
    return { iteration, sandboxed, checks: [] };
  }

  const checks: AnalysisCheck[] = [];

  info(`Installing dependencies for analysis${sandboxed ? ' (sandboxed, network on)' : ' (host)'}...`);
  const install = runStep(outputDir, artifact.installCommand, sandboxed, image, 300_000, true);
  checks.push({
    name: 'dependency-install',
    ran: true,
    passed: install.passed,
    output: install.output.slice(0, 4000),
  });

  if (!install.passed) {
    warn('Dependency install failed before static analysis could run â€” skipping remaining checks for this iteration.');
    return { iteration, sandboxed, checks };
  }

  for (const spec of specs) {
    info(`Running check: ${spec.name}${sandboxed ? ' (sandboxed)' : ' (host)'}`);
    const { passed, output } = runStep(outputDir, spec.command, sandboxed, image, 120_000, spec.needsNetwork);

    checks.push({
      name: spec.name,
      ran: true,
      passed,
      // Static tool output can be long; keep only enough to be useful context.
      output: output.slice(0, 4000),
    });
  }

  return { iteration, sandboxed, checks };
}

// Renders a report as compact, LLM-readable evidence text for the Reviewer prompt.
export function formatAnalysisForLLM(report: AnalysisReport): string {
  if (report.checks.length === 0) {
    return 'No static analysis checks were applicable to this codebase.';
  }
  return report.checks
    .map((c) => `### ${c.name} â€” ${c.passed ? 'PASSED' : 'FAILED'}\n${c.output || '(no output)'}`)
    .join('\n\n');
}
