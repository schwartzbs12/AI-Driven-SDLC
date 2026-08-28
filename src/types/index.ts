export type PipelineStage =
  | 'access_check'
  | 'intake'
  | 'architecture'
  | 'architecture_approval'
  | 'building'
  | 'demo_checkpoint'
  | 'code_review'
  | 'debugging_review'
  | 'qa'
  | 'debugging_qa'
  | 'delivery'
  | 'hypercare'
  | 'complete';

export interface ProductBrief {
  userGoal: string;
  personas: string[];
  coreFlows: string[];
  constraints: string[];
  edgeCases: string[];
  risks: string[];
  techPreferences: string;
  successCriteria: string[];
}

export interface TechStack {
  language: string;
  framework: string;
  database?: string;
  testingFramework: string;
  packageManager: string;
  additionalLibraries: string[];
}

export interface Component {
  name: string;
  type: string;
  responsibility: string;
  dependencies: string[];
  filePath: string;
}

export interface ArchitectureDocument {
  overview: string;
  techStack: TechStack;
  components: Component[];
  dataModels: string;
  apiContracts: string;
  edgeCases: string[];
  securityConsiderations: string;
  diagram: string;
  rawMarkdown: string;
}

export interface CodeFile {
  path: string;
  content: string;
  language: string;
}

export interface SourceCodeArtifact {
  files: CodeFile[];
  entryPoint: string;
  testCommand: string;
  installCommand: string;
  structure: string;
}

export interface ReviewIssue {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line?: number;
  description: string;
  suggestion: string;
  category: 'bug' | 'security' | 'architecture' | 'performance' | 'style';
  // Set by the Verifier agent (B2) â€” absent until verification runs.
  // 'confirmed'    â€” verifier agrees the issue is real; blocks approval.
  // 'unconfirmed'  â€” verifier actively checked and disagrees; does NOT block.
  // 'inconclusive' â€” verifier call failed/unparseable; unknown, so it fails
  //                  closed and blocks (same as 'confirmed') rather than
  //                  silently dropping the original reviewer's finding.
  verdict?: 'confirmed' | 'unconfirmed' | 'inconclusive';
  verdictReason?: string;
}

export interface ReviewReport {
  iteration: number;
  issues: ReviewIssue[];
  passedChecks: string[];
  summary: string;
  // The Reviewer's own self-assessment. Do not treat as authoritative for
  // gating â€” the orchestrator gates on verifiedApproved instead (B2).
  approved: boolean;
  // Computed after the Verifier pass: true only when zero confirmed or
  // unconfirmed critical/high issues remain (unconfirmed still blocks â€”
  // fails closed, consistent with the reviewer's own fail-closed behavior).
  verifiedApproved?: boolean;
}

export interface AnalysisCheck {
  name: string;
  ran: boolean;
  passed: boolean;
  output: string;
}

export interface AnalysisReport {
  iteration: number;
  sandboxed: boolean;
  checks: AnalysisCheck[];
}

export interface Fix {
  issueId: string;
  file: string;
  description: string;
}

export interface DebugRun {
  iteration: number;
  source: 'review' | 'qa';
  issueCount: number;
  fixesApplied: Fix[];
  updatedFiles: CodeFile[];
  timestamp: string;
}

export interface QATest {
  id: string;
  order: number;
  name: string;
  workflow: string;
  description: string;
  testCode: string;
  status: 'pending' | 'passed' | 'failed' | 'skipped';
  error?: string;
}

export interface QAResults {
  iteration: number;
  tests: QATest[];
  passed: number;
  failed: number;
  total: number;
  allPassed: boolean;
}

// What's actually true right now: the latest approved/built state.
export interface CurrentTruth {
  productBrief?: ProductBrief;
  architecture?: ArchitectureDocument;
  sourceCode?: SourceCodeArtifact;
}

// Approved-but-not-yet-realized state and open loops the record is
// carrying forward â€” distinct from what's already true above.
export interface FutureIntent {
  architectureRevisionNotes?: string;
  demoCheckpointNotes?: string;
  hypercareOwner?: string;
  hypercareWindow?: string;
  hypercareNotes?: string;
}

// Append-only evidence log â€” never mutated in place, only grown.
export interface HistoryEvidence {
  reviewReports: ReviewReport[];
  analysisReports: AnalysisReport[];
  debugRuns: DebugRun[];
  qaResults: QAResults[];
}

export interface SessionState {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  stage: PipelineStage;
  outputDir: string;
  currentTruth: CurrentTruth;
  futureIntent: FutureIntent;
  history: HistoryEvidence;
}
