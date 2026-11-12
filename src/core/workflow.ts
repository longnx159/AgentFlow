import { AppError, validateExecution } from './settings.js';
import type { Dict, FlowNode, WorkflowDefinition } from '../shared/types.js';
export function readPath(object: any, path: string): any {
  if (path === '') return object;
  return path
    .split('.')
    .reduce(
      (v, k) => (['__proto__', 'prototype', 'constructor'].includes(k) ? undefined : v?.[k]),
      object,
    );
}
export function evaluateRule(rule: any, data: Dict): any {
  if (rule === null || typeof rule !== 'object') return rule;
  if (Array.isArray(rule)) return rule.map((x) => evaluateRule(x, data));
  const keys = Object.keys(rule);
  if (keys.length !== 1) throw new AppError('A rule needs exactly one operator');
  const op = keys[0],
    arg = rule[op];
  if (op === 'var')
    return (
      readPath(data, Array.isArray(arg) ? arg[0] : String(arg)) ??
      (Array.isArray(arg) ? arg[1] : undefined)
    );
  const args = Array.isArray(arg) ? arg : [arg];
  if (op === 'and') return args.every((x) => Boolean(evaluateRule(x, data)));
  if (op === 'or') return args.some((x) => Boolean(evaluateRule(x, data)));
  if (op === '!') return !evaluateRule(args[0], data);
  if (op === 'exists') return readPath(data, String(args[0])) !== undefined;
  const [a, b] = args.map((x) => evaluateRule(x, data));
  switch (op) {
    case '===':
    case '==':
      return a !== undefined && b !== undefined && a === b;
    case '!==':
    case '!=':
      return a !== undefined && b !== undefined && a !== b;
    case '>':
      return typeof a === 'number' && typeof b === 'number' && a > b;
    case '>=':
      return typeof a === 'number' && typeof b === 'number' && a >= b;
    case '<':
      return typeof a === 'number' && typeof b === 'number' && a < b;
    case '<=':
      return typeof a === 'number' && typeof b === 'number' && a <= b;
    case 'contains':
      return typeof a === 'string' && typeof b === 'string'
        ? a.includes(b)
        : Array.isArray(a) && a.includes(b);
    case 'in':
      return typeof b === 'string' && typeof a === 'string'
        ? b.includes(a)
        : Array.isArray(b) && b.includes(a);
    default:
      throw new AppError(`Unsupported rule operator ${op}`);
  }
}
export function edges(n: FlowNode, includeRepeat = true) {
  return [
    n.next,
    ...(n.cases ?? []).map((c) => c.next),
    n.otherwise,
    ...(includeRepeat && n.type === 'repeat' ? [n.target] : []),
  ].filter((s): s is string => Boolean(s));
}
export function validateWorkflow(w: WorkflowDefinition) {
  if (
    !w ||
    typeof w.id !== 'string' ||
    !w.id ||
    typeof w.name !== 'string' ||
    !Array.isArray(w.nodes) ||
    !Array.isArray(w.triggers)
  )
    throw new AppError('Invalid workflow');
  const ids = new Set<string>();
  for (const n of w.nodes) {
    if (!n.id || ids.has(n.id)) throw new AppError('Duplicate or empty node id');
    ids.add(n.id);
    if (!['start', 'task', 'review', 'condition', 'repeat', 'delay', 'end'].includes(n.type))
      throw new AppError(`Unsupported node type ${n.type}`);
    validateExecution(n.timeout ?? {});
    if (
      n.type === 'repeat' &&
      (!Number.isSafeInteger(n.maxIterations ?? 3) || (n.maxIterations ?? 3) < 1 || !n.target)
    )
      throw new AppError('Repeat needs a target and finite maxIterations');
    if (n.type === 'condition') {
      if (!Array.isArray(n.cases) || !n.cases.length) throw new AppError('Condition needs cases');
      for (const c of n.cases) evaluateRule(c.when, {});
    }
    if (n.delaySec !== undefined && (!Number.isFinite(n.delaySec) || n.delaySec < 0))
      throw new AppError('Invalid delay');
    if (n.until !== undefined && !Number.isFinite(Date.parse(n.until)))
      throw new AppError('Invalid delay until');
  }
  if (!ids.has(w.entry) || w.nodes.find((n) => n.id === w.entry)?.type !== 'start')
    throw new AppError('Entry must be a Start node');
  for (const n of w.nodes)
    for (const target of edges(n))
      if (!ids.has(target)) throw new AppError(`Missing node ${target}`);
  // Removing the Repeat return edges must break every cycle, not merely one cycle in an SCC.
  const done = new Set<string>(),
    visiting = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new AppError('Cycle must consume an explicit Repeat budget');
    if (done.has(id)) return;
    visiting.add(id);
    for (const t of edges(
      w.nodes.find((n) => n.id === id)!,
      false,
    ))
      visit(t);
    visiting.delete(id);
    done.add(id);
  }
  for (const id of ids) visit(id);
  const reachable = new Set<string>();
  function mark(id: string) {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const target of edges(w.nodes.find((n) => n.id === id)!)) mark(target);
  }
  mark(w.entry);
  if (reachable.size !== ids.size) throw new AppError('Workflow has unreachable nodes');
  validateExecution(w.execution ?? {});
  for (const [k, v] of Object.entries(w.limits ?? {}))
    if (
      !['perWorkflowConcurrentRuns', 'maxQueuedRuns', 'maxStepExecutions', 'maxChainRuns'].includes(
        k,
      ) ||
      !Number.isSafeInteger(v) ||
      v <= 0
    )
      throw new AppError(`Invalid workflow limit ${k}`);
  const triggers = new Set<string>();
  for (const t of w.triggers) {
    if (
      !t.id ||
      triggers.has(t.id) ||
      !['manual', 'schedule', 'event', 'workflow'].includes(t.type)
    )
      throw new AppError('Invalid or duplicate trigger');
    triggers.add(t.id);
    if (t.when) evaluateRule(t.when, {});
    if (t.type === 'schedule') {
      if (Boolean(t.cron) === Boolean(t.intervalSec))
        throw new AppError('Schedule needs cron OR intervalSec');
      if (t.intervalSec !== undefined && (!Number.isFinite(t.intervalSec) || t.intervalSec <= 0))
        throw new AppError('Invalid interval');
      new Intl.DateTimeFormat('en', { timeZone: t.timezone ?? 'Asia/Saigon' });
    }
    if (t.type === 'workflow' && !t.sourceWorkflowId)
      throw new AppError('Workflow trigger needs sourceWorkflowId');
  }
  return structuredClone(w);
}
export function render(template: string, context: Dict): string {
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_all, path) => {
    const v = readPath(context, path.trim());
    if (v === undefined) throw new AppError(`Input binding not available: ${path}`);
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}
