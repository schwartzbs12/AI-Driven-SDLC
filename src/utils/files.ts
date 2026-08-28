import * as fs from 'fs-extra';
import * as path from 'path';
import { CodeFile, SourceCodeArtifact } from '../types/index';

// Guards against a file path (LLM-supplied) writing outside outputDir via
// absolute paths or ../ segments.
export function isPathSafe(outputDir: string, relPath: string): boolean {
  const root = path.resolve(outputDir);
  const resolved = path.resolve(root, relPath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

// Structural check usable before outputDir is known (e.g. at LLM-output
// parse time): rejects absolute paths and upward traversal.
function isStructurallySafeRelativePath(relPath: string): boolean {
  if (path.isAbsolute(relPath)) return false;
  const normalized = path.normalize(relPath);
  return normalized !== '..' && !normalized.startsWith(`..${path.sep}`) && !normalized.startsWith('../');
}

export async function writeSourceCode(
  outputDir: string,
  artifact: SourceCodeArtifact
): Promise<void> {
  await fs.ensureDir(outputDir);
  for (const file of artifact.files) {
    if (!isPathSafe(outputDir, file.path)) {
      console.warn(`Skipping file with unsafe path outside output directory: ${file.path}`);
      continue;
    }
    const fullPath = path.join(outputDir, file.path);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, file.content, 'utf8');
  }
}

export async function writeFile(outputDir: string, file: CodeFile): Promise<void> {
  if (!isPathSafe(outputDir, file.path)) {
    console.warn(`Skipping file with unsafe path outside output directory: ${file.path}`);
    return;
  }
  const fullPath = path.join(outputDir, file.path);
  await fs.ensureDir(path.dirname(fullPath));
  await fs.writeFile(fullPath, file.content, 'utf8');
}

export async function readOutputFiles(outputDir: string): Promise<CodeFile[]> {
  const files: CodeFile[] = [];
  await collectFiles(outputDir, outputDir, files);
  return files;
}

async function collectFiles(
  rootDir: string,
  currentDir: string,
  files: CodeFile[]
): Promise<void> {
  const IGNORE = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    '__pycache__',
    '.pytest_cache',
    'coverage',
    '.nyc_output',
  ]);

  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORE.has(entry.name)) continue;
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      await collectFiles(rootDir, fullPath, files);
    } else {
      const content = await fs.readFile(fullPath, 'utf8');
      files.push({
        path: relativePath,
        content,
        language: detectLanguage(entry.name),
      });
    }
  }
}

export function detectLanguage(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.md': 'markdown',
    '.sh': 'bash',
    '.env': 'bash',
    '.sql': 'sql',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
  };
  return map[ext] ?? 'text';
}

export function parseCodeFilesFromLLMOutput(raw: string): CodeFile[] {
  const files: CodeFile[] = [];
  const fileRegex = /<file\s+path="([^"]+)"(?:\s+language="([^"]*)")?>([\s\S]*?)<\/file>/g;
  let match: RegExpExecArray | null;

  while ((match = fileRegex.exec(raw)) !== null) {
    const [, rawFilePath, language, content] = match;
    const filePath = rawFilePath.trim();

    if (!isStructurallySafeRelativePath(filePath)) {
      console.warn(`Dropping file block with unsafe path from LLM output: ${filePath}`);
      continue;
    }

    files.push({
      path: filePath,
      content: content.trim(),
      language: language?.trim() ?? detectLanguage(filePath),
    });
  }

  return files;
}

export function formatFilesForLLM(files: CodeFile[]): string {
  return files
    .map(
      (f) =>
        `<file path="${f.path}" language="${f.language}">\n${f.content}\n</file>`
    )
    .join('\n\n');
}

export async function getDirectoryStructure(dir: string): Promise<string> {
  const lines: string[] = [];
  await buildTree(dir, dir, lines, '');
  return lines.join('\n');
}

async function buildTree(
  rootDir: string,
  currentDir: string,
  lines: string[],
  prefix: string
): Promise<void> {
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', 'coverage']);
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const filtered = entries.filter((e) => !IGNORE.has(e.name));

  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i];
    const isLast = i === filtered.length - 1;
    const connector = isLast ? 'â””â”€â”€ ' : 'â”œâ”€â”€ ';
    lines.push(`${prefix}${connector}${entry.name}`);

    if (entry.isDirectory()) {
      const nextPrefix = prefix + (isLast ? '    ' : 'â”‚   ');
      await buildTree(rootDir, path.join(currentDir, entry.name), lines, nextPrefix);
    }
  }
}
