import * as fs from 'fs-extra';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { SessionState, PipelineStage } from '../types/index';

const SESSIONS_DIR = path.resolve(process.cwd(), 'sessions');

export async function createSession(outputDir: string): Promise<SessionState> {
  await fs.ensureDir(SESSIONS_DIR);

  const state: SessionState = {
    sessionId: uuidv4(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stage: 'access_check',
    outputDir,
    currentTruth: {},
    futureIntent: {},
    history: {
      reviewReports: [],
      analysisReports: [],
      debugRuns: [],
      qaResults: [],
    },
  };

  await saveSession(state);
  return state;
}

export async function saveSession(state: SessionState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const filePath = path.join(SESSIONS_DIR, `${state.sessionId}.json`);
  await fs.writeJson(filePath, state, { spaces: 2 });
}

export async function loadSession(sessionId: string): Promise<SessionState> {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  return fs.readJson(filePath) as Promise<SessionState>;
}

export async function listSessions(): Promise<string[]> {
  await fs.ensureDir(SESSIONS_DIR);
  const files = await fs.readdir(SESSIONS_DIR);
  return files.filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
}

export function advanceStage(state: SessionState, stage: PipelineStage): void {
  state.stage = stage;
}
