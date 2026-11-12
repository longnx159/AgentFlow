import type { WorkflowDefinition, FlowNode, Trigger, Dict } from '../shared/types.js';
export interface EditorNode {
  id: string;
  type: string;
  z?: string;
  [key: string]: any;
}
export const allowedTypes = new Set([
  'tab',
  'comment',
  'af-start',
  'af-task',
  'af-review',
  'af-condition',
  'af-repeat',
  'af-delay',
  'af-end',
]);
export function assertAllowedDraft(value: unknown): asserts value is EditorNode[] {
  if (!Array.isArray(value)) throw new Error('Draft must be a flat node array');
  const ids = new Set<string>();
  for (const node of value) {
    if (!node || typeof node.id !== 'string' || !node.id || typeof node.type !== 'string')
      throw new Error('Each draft node needs id and type');
    if (!allowedTypes.has(node.type))
      throw new Error(`Node type ${node.type} is not allowed; use Agent Flow nodes only`);
    if (ids.has(node.id)) throw new Error(`Duplicate node id ${node.id}`);
    ids.add(node.id);
  }
}
function json<T>(value: any, fallback: T, label: string): T {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`${label}: invalid JSON`);
    }
  }
  return structuredClone(value);
}
function object(value: any, label: string): Dict | undefined {
  const result = json<any>(value, undefined, label);
  if (result !== undefined && (!result || typeof result !== 'object' || Array.isArray(result)))
    throw new Error(`${label} must be a JSON object`);
  return result;
}
export function compileFlow(draft: unknown, tabId: string): WorkflowDefinition {
  assertAllowedDraft(draft);
  const tab = draft.find((n) => n.type === 'tab' && n.id === tabId);
  if (!tab) throw new Error(`Tab ${tabId} was not found`);
  const source = draft.filter((n) => n.z === tabId && n.type !== 'comment');
  const ids = new Set(source.map((n) => n.id));
  const starts = source.filter((n) => n.type === 'af-start');
  if (starts.length !== 1) throw new Error('Workflow tab requires exactly one Start node');
  function target(id: any): string {
    if (typeof id !== 'string' || !ids.has(id))
      throw new Error(`Wire target ${id} is outside the selected tab`);
    return id;
  }
  const nodes: FlowNode[] = source.map((n) => {
    const result: FlowNode = { id: n.id, type: n.type.slice(3) as FlowNode['type'] };
    if (n.name) result.name = String(n.name);
    const wires = n.wires ?? [];
    if (!Array.isArray(wires) || wires.some((out: any) => !Array.isArray(out)))
      throw new Error(`Invalid wires on ${n.id}`);
    for (const out of wires) {
      if (out.length > 1)
        throw new Error(`Ambiguous branch wires on ${n.id}; one target per output is required`);
      for (const id of out) target(id);
    }
    if (result.type === 'condition') {
      const cases = json<any>(n.cases, [], `${n.id} cases`);
      if (!Array.isArray(cases)) throw new Error('Condition cases must be a JSON array');
      result.cases = cases.map((item: any, index: number) => {
        const when = item?.when ?? item;
        if (!when || typeof when !== 'object' || Array.isArray(when))
          throw new Error('Each condition case must be a JSON logic object');
        return { when, next: target(wires[index]?.[0] ?? item.next) };
      });
      if (wires[cases.length]?.[0] ?? n.otherwise)
        result.otherwise = target(wires[cases.length]?.[0] ?? n.otherwise);
      if (wires.length > cases.length + 1) throw new Error('Condition has extra output wires');
    } else {
      if (wires.length > 1 && wires.slice(1).some((x: any) => x.length))
        throw new Error(`Unexpected branch wires on ${n.id}`);
      if (wires[0]?.[0]) result.next = target(wires[0][0]);
    }
    if (result.type === 'task' || result.type === 'review') {
      for (const field of ['skill', 'rubric', 'role', 'input'] as const)
        if (n[field] !== undefined && n[field] !== '') result[field] = String(n[field]);
    }
    const timeout = object(n.timeout, `${n.id} execution override`);
    if (timeout) result.timeout = timeout;
    if (result.type === 'repeat') {
      result.target = target(n.target);
      result.maxIterations = Number(n.maxIterations ?? 3);
      if (!Number.isSafeInteger(result.maxIterations) || result.maxIterations < 1)
        throw new Error('Repeat maxIterations must be a positive integer');
    }
    if (result.type === 'delay' || result.type === 'repeat') {
      if (n.delaySec !== undefined && n.delaySec !== '') {
        result.delaySec = Number(n.delaySec);
        if (!Number.isFinite(result.delaySec) || result.delaySec < 0)
          throw new Error('Delay must be a nonnegative number');
      }
      if (n.until) result.until = String(n.until);
    }
    if (result.type === 'end') {
      result.outcome = n.outcome === 'failed' ? 'failed' : 'succeeded';
      if (n.outputNodeId) result.outputNodeId = target(n.outputNodeId);
    }
    return result;
  });
  const triggers = json<Trigger[]>(
    starts[0].triggers,
    [{ id: 'manual', type: 'manual' }],
    'Start triggers',
  );
  if (!Array.isArray(triggers)) throw new Error('Start triggers must be a JSON array');
  const result: WorkflowDefinition = {
    id: tabId,
    name: String(tab.label || tab.name || tabId),
    enabled: tab.enabled !== false && tab.disabled !== true,
    entry: starts[0].id,
    nodes,
    triggers,
  };
  const execution = object(tab.execution ?? starts[0].execution, 'Workflow execution');
  if (execution) result.execution = execution;
  const limits = object(tab.limits ?? starts[0].limits, 'Workflow limits');
  if (limits) result.limits = limits;
  return result;
}
