import type { Settings, ExecutionSettings, ConnectionSettings, Dict } from '../shared/types.js';
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function defaults(): Settings {
  return {
    version: 1,
    connection: {
      longPollWaitSec: 25,
      longPollHttpTimeoutSec: 35,
      apiRequestTimeoutSec: 30,
      heartbeatIntervalSec: 10,
      offlineAfterSec: 30,
      preSendLeaseSec: 60,
      artifactTransferIdleSec: 60,
    },
    execution: {
      noProgressTimeoutSec: 600,
      stepTotalTimeoutSec: null,
      workflowTotalTimeoutSec: null,
      timeoutAction: 'warn',
    },
    limits: {
      globalConcurrentRuns: 2,
      perWorkflowConcurrentRuns: 1,
      maxQueuedRuns: 100,
      maxStepExecutions: 100,
      maxChainRuns: 10,
    },
    workerOverrides: {},
  };
}
export function resolveExecution(
  base: ExecutionSettings,
  ...overrides: (Partial<ExecutionSettings> | undefined)[]
): ExecutionSettings {
  const result = { ...base };
  for (const o of overrides)
    if (o) for (const [k, v] of Object.entries(o)) if (v !== undefined) (result as Dict)[k] = v;
  validateExecution(result);
  return result;
}
export function validateExecution(e: Partial<ExecutionSettings>) {
  for (const k of [
    'noProgressTimeoutSec',
    'stepTotalTimeoutSec',
    'workflowTotalTimeoutSec',
  ] as const) {
    const v = e[k];
    if (v !== undefined && v !== null && (!Number.isFinite(v) || v <= 0))
      throw new AppError(`${k} must be positive or null`);
  }
  if (e.timeoutAction !== undefined && !['warn', 'pause', 'stop'].includes(e.timeoutAction))
    throw new AppError('Invalid timeoutAction');
  for (const k of Object.keys(e))
    if (!(k in defaults().execution)) throw new AppError(`Unknown execution setting: ${k}`);
}
export function validateConnection(c: ConnectionSettings) {
  for (const [k, v] of Object.entries(c))
    if (!(k in defaults().connection) || !Number.isFinite(v) || v <= 0)
      throw new AppError(`Invalid connection setting ${k}`);
  if (c.longPollHttpTimeoutSec <= c.longPollWaitSec)
    throw new AppError('longPollHttpTimeoutSec must exceed longPollWaitSec');
  if (c.offlineAfterSec <= c.heartbeatIntervalSec)
    throw new AppError('offlineAfterSec must exceed heartbeatIntervalSec');
  if (c.preSendLeaseSec <= c.offlineAfterSec)
    throw new AppError('preSendLeaseSec must exceed offlineAfterSec');
}
export function validateSettings(s: Settings) {
  validateConnection(s.connection);
  validateExecution(s.execution);
  for (const [k, v] of Object.entries(s.limits))
    if (!(k in defaults().limits) || !Number.isSafeInteger(v) || v <= 0)
      throw new AppError(`Invalid limit ${k}`);
  for (const [id, o] of Object.entries(s.workerOverrides)) {
    if (!id) throw new AppError('Empty worker id');
    validateConnection({ ...s.connection, ...o });
  }
  return s;
}
export function mergeSettings(previous: Settings, patch: Dict): Settings {
  for (const k of Object.keys(patch))
    if (!['version', 'connection', 'execution', 'limits', 'workerOverrides'].includes(k))
      throw new AppError(`Unknown settings group ${k}`);
  const s = {
    ...previous,
    ...patch,
    version: previous.version + 1,
    connection: { ...previous.connection, ...patch.connection },
    execution: { ...previous.execution, ...patch.execution },
    limits: { ...previous.limits, ...patch.limits },
    workerOverrides: patch.workerOverrides ?? previous.workerOverrides,
  };
  return validateSettings(s);
}
