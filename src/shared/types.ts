export type Dict = Record<string, any>;
export interface ConnectionSettings {
  longPollWaitSec: number;
  longPollHttpTimeoutSec: number;
  apiRequestTimeoutSec: number;
  heartbeatIntervalSec: number;
  offlineAfterSec: number;
  preSendLeaseSec: number;
  artifactTransferIdleSec: number;
}
export interface ExecutionSettings {
  noProgressTimeoutSec: number | null;
  stepTotalTimeoutSec: number | null;
  workflowTotalTimeoutSec: number | null;
  timeoutAction: 'warn' | 'pause' | 'stop';
}
export interface Limits {
  globalConcurrentRuns: number;
  perWorkflowConcurrentRuns: number;
  maxQueuedRuns: number;
  maxStepExecutions: number;
  maxChainRuns: number;
}
export interface Settings {
  version: number;
  connection: ConnectionSettings;
  execution: ExecutionSettings;
  limits: Limits;
  workerOverrides: Record<string, Partial<ConnectionSettings>>;
}
export type NodeKind = 'start' | 'task' | 'review' | 'condition' | 'repeat' | 'delay' | 'end';
export interface FlowNode {
  id: string;
  type: NodeKind;
  name?: string;
  next?: string;
  skill?: string;
  rubric?: string;
  role?: string;
  input?: string;
  timeout?: Partial<ExecutionSettings>;
  cases?: { when: Dict; next: string }[];
  otherwise?: string;
  target?: string;
  maxIterations?: number;
  delaySec?: number;
  until?: string;
  outcome?: 'succeeded' | 'failed';
  outputNodeId?: string;
}
export interface Trigger {
  id: string;
  type: 'manual' | 'schedule' | 'event' | 'workflow';
  cron?: string;
  intervalSec?: number;
  timezone?: string;
  eventType?: string;
  sourceWorkflowId?: string;
  when?: Dict;
  overlap?: 'queue' | 'skip';
  missed?: 'skip' | 'catchUpLatest';
  input?: unknown;
}
export interface WorkflowDefinition {
  id: string;
  name: string;
  enabled: boolean;
  entry: string;
  nodes: FlowNode[];
  triggers: Trigger[];
  execution?: Partial<ExecutionSettings>;
  limits?: Partial<Omit<Limits, 'globalConcurrentRuns'>>;
}
export interface AttemptJob {
  id: string;
  jobId: string;
  runId: string;
  nodeExecutionId: string;
  nodeId: string;
  workerId: string;
  generation: string;
  fence: string;
  state: string;
  prompt: string;
  execution: ExecutionSettings;
  createdAt: number;
  leaseUntil: number;
}
export interface BrowserResult {
  status: 'complete' | 'partial' | 'uncertain' | 'failed';
  text?: string;
  conversationId?: string;
  userMessageId?: string;
  replyId?: string;
  parts?: unknown[];
  metadata?: Dict;
  error?: string;
}
