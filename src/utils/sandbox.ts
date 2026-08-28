import * as childProcess from 'child_process';

let dockerAvailable: boolean | null = null;

// Cheapest viable sandbox: run install/test commands inside a disposable,
// network-disabled Docker container instead of directly on the host.
export function isDockerAvailable(): boolean {
  if (dockerAvailable !== null) return dockerAvailable;
  try {
    childProcess.execSync('docker --version', { stdio: 'ignore' });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

// Picks a generic base image from the artifact's own install/test commands
// rather than requiring an explicit tech-stack parameter.
export function inferDockerImage(installCommand: string, testCommand: string): string {
  const combined = `${installCommand} ${testCommand}`.toLowerCase();
  if (/\bcargo\b/.test(combined)) return 'rust:1-slim';
  if (/\b(mvn|maven)\b/.test(combined)) return 'maven:3-eclipse-temurin-21';
  if (/\bgradle\b/.test(combined)) return 'gradle:8-jdk21';
  if (/\bgo\b/.test(combined)) return 'golang:1.22-alpine';
  if (/\b(pip|pytest|python)\b/.test(combined)) return 'python:3.12-slim';
  return 'node:20-slim';
}

export interface SandboxResult {
  status: 'success' | 'failure';
  output: string;
}

export function runInSandbox(
  outputDir: string,
  command: string,
  image: string,
  timeoutMs: number,
  // Network is off by default â€” the meaningful isolation boundary is around
  // *executing untrusted generated application/test code*. Steps that only
  // fetch known tooling or query an advisory database (install, audit) need
  // it explicitly enabled; steps that run already-installed tools (tsc,
  // eslint, the actual test run) should keep it off.
  network: boolean = false
): SandboxResult {
  const dockerArgs = [
    'run',
    '--rm',
    '--network',
    network ? 'bridge' : 'none',
    '--memory',
    '1g',
    '--cpus',
    '2',
    '-v',
    `${outputDir}:/work`,
    '-w',
    '/work',
    image,
    'sh',
    '-c',
    command,
  ];

  try {
    const output = childProcess.execFileSync('docker', dockerArgs, {
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 'success', output };
  } catch (err: unknown) {
    const execError = err as { stdout?: string; stderr?: string; message?: string };
    const output = [execError.stdout ?? '', execError.stderr ?? '', execError.message ?? ''].join('\n');
    return { status: 'failure', output };
  }
}
