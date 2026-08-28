import * as childProcess from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { info, warn } from './cli';

let gitAvailable: boolean | null = null;

export function isGitAvailable(): boolean {
  if (gitAvailable !== null) return gitAvailable;
  try {
    childProcess.execSync('git --version', { stdio: 'ignore' });
    gitAvailable = true;
  } catch {
    gitAvailable = false;
  }
  return gitAvailable;
}

function run(outputDir: string, args: string[]): { success: boolean; output: string } {
  try {
    const output = childProcess.execFileSync('git', args, {
      cwd: outputDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, output };
  } catch (err: unknown) {
    const execError = err as { stdout?: string; stderr?: string; message?: string };
    const output = [execError.stdout ?? '', execError.stderr ?? '', execError.message ?? ''].join('\n');
    return { success: false, output };
  }
}

// Local-only history for the *generated* project (this session's outputDir),
// not for the SDLC Agent System tool itself. Init once, commit after each
// meaningful pipeline stage. No remote, no push, no PR â€” purely about giving
// the generated codebase a real, inspectable commit history instead of
// silently-overwritten files.
export async function ensureRepo(outputDir: string): Promise<boolean> {
  if (!isGitAvailable()) {
    warn('git is not available on PATH â€” skipping commit history for generated output.');
    return false;
  }

  const gitDir = path.join(outputDir, '.git');
  if (await fs.pathExists(gitDir)) return true;

  const init = run(outputDir, ['init']);
  if (!init.success) {
    warn(`git init failed in ${outputDir}: ${init.output}`);
    return false;
  }

  // Scoped to this repo only (--local is implied by running inside it before
  // any global identity is required) â€” doesn't touch the user's global git config.
  run(outputDir, ['config', 'user.name', 'SDLC Agent System']);
  run(outputDir, ['config', 'user.email', 'sdlc-agent-system@local']);

  // The Builder agent isn't guaranteed to emit a .gitignore, and by the time
  // commits happen node_modules has usually been installed by the QA/analysis
  // stages. Without this, the first commit would include it wholesale.
  const gitignorePath = path.join(outputDir, '.gitignore');
  if (!(await fs.pathExists(gitignorePath))) {
    await fs.writeFile(
      gitignorePath,
      ['node_modules/', 'dist/', 'build/', '__pycache__/', '.pytest_cache/', 'coverage/', '.nyc_output/', '.env'].join('\n') + '\n',
      'utf8'
    );
  }

  info(`Initialized local git repository for generated output: ${outputDir}`);
  return true;
}

export async function commitStage(outputDir: string, message: string): Promise<void> {
  const ready = await ensureRepo(outputDir);
  if (!ready) return;

  const add = run(outputDir, ['add', '-A']);
  if (!add.success) {
    warn(`git add failed in ${outputDir}: ${add.output}`);
    return;
  }

  // A stage can run without changing any files â€” that's not an error.
  const status = run(outputDir, ['status', '--porcelain']);
  if (status.success && status.output.trim() === '') {
    return;
  }

  const commit = run(outputDir, ['commit', '-m', message]);
  if (!commit.success) {
    warn(`git commit failed in ${outputDir}: ${commit.output}`);
    return;
  }

  info(`Committed: ${message}`);
}
