import { randomUUID, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { Store } from './store.js';
import { AppError, defaults, mergeSettings, resolveExecution } from './settings.js';
import { edges, evaluateRule, render, validateWorkflow } from './workflow.js';
import type {
  Dict,
  Settings,
  WorkflowDefinition,
  Trigger,
  AttemptJob,
  FlowNode,
} from '../shared/types.js';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const activeRun = (r: Dict) => ['running', 'uncertain', 'paused', 'needsReview'].includes(r.status);
const activeAttempt = (a: Dict) =>
  ['assigned', 'sending', 'running', 'uncertain'].includes(a.state);
const safeId = (id: string) => {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) throw new AppError('Invalid identifier');
  return id;
};
const fairPick = (items: Dict[], last?: string) => {
  const groups = [...new Set(items.map((x) => x.workflowId))];
  const index = groups.indexOf(last);
  const selected = groups[(index + 1) % groups.length];
  return items.find((x) => x.workflowId === selected);
};

export class Engine {
  readonly store: Store;
  readonly dataDir: string;
  readonly artifactsDir: string;
  readonly now: () => number;
  private readonly pairingToken: string;
  constructor(options: { dataDir: string; now?: () => number; pairingToken?: string }) {
    this.dataDir = options.dataDir;
    this.now = options.now ?? Date.now;
    this.pairingToken = options.pairingToken ?? '';
    this.artifactsDir = join(this.dataDir, 'artifacts');
    mkdirSync(this.artifactsDir, { recursive: true });
    this.store = new Store(join(this.dataDir, 'manager.sqlite'));
    if (!this.store.get('config', 'settings'))
      this.store.put('config', { id: 'settings', ...defaults() });
    // The disk, not a disappeared HTTP connection, defines which attempts might have sent.
    this.store.tx(() => {
      for (const a of this.store.all('attempt'))
        if (['sending', 'running'].includes(a.state))
          this.markUncertain(a, 'Manager restarted; observation required');
    });
  }
  close() {
    this.store.close();
  }
  getSettings(): Settings {
    const s = this.store.get('config', 'settings');
    delete s.id;
    return s;
  }
  updateSettings(patch: Dict) {
    return this.store.tx(() => {
      const s = mergeSettings(this.getSettings(), patch);
      this.store.put('config', { id: 'settings', ...s });
      this.audit('settings.updated', { version: s.version });
      return s;
    });
  }
  private connectionFor(id: string) {
    const s = this.getSettings();
    return { ...s.connection, ...s.workerOverrides[id] };
  }
  private peerSettings(w: Dict) {
    const c = this.connectionFor(w.id);
    if (w.settingsVersion === this.getSettings().version) return c;
    return Object.fromEntries(
      Object.entries(c).map(([k, v]) => [k, Math.max(v, w.connection?.[k] ?? v)]),
    ) as typeof c;
  }
  private configResponse(id: string) {
    return { settingsVersion: this.getSettings().version, connection: this.connectionFor(id) };
  }
  private audit(type: string, payload: Dict) {
    this.store.put('audit', { id: randomUUID(), type, at: this.now(), ...payload });
  }
  publish(definition: WorkflowDefinition) {
    return this.store.tx(() => {
      const def = validateWorkflow(definition);
      safeId(def.id);
      const old = this.store.get('workflow', def.id);
      const digest = hash(JSON.stringify(def));
      if (old?.digest === digest) return old;
      for (const trigger of def.triggers) if (trigger.cron) this.nextSchedule(trigger, this.now());
      const published = {
        id: def.id,
        name: def.name,
        enabled: def.enabled,
        version: (old?.version ?? 0) + 1,
        digest,
        definition: def,
        publishedAt: this.now(),
      };
      this.store.put('workflow', published);
      for (const t of def.triggers.filter((x) => x.type === 'schedule')) {
        const id = `${def.id}:${t.id}`,
          saved = this.store.get('schedule', id);
        const digest = hash(JSON.stringify(t));
        if (!saved || saved.digest !== digest)
          this.store.put('schedule', {
            id,
            workflowId: def.id,
            triggerId: t.id,
            digest,
            nextAt: this.nextSchedule(t, this.now()),
          });
      }
      this.audit('workflow.published', { workflowId: def.id, version: published.version });
      return published;
    });
  }
  listWorkflows() {
    return this.store.all('workflow');
  }
  getRun(id: string) {
    const r = this.store.get('run', id);
    if (!r) throw new AppError('Run not found', 404);
    return {
      ...r,
      executions: this.store.all('execution').filter((x) => x.runId === id),
      attempts: this.store
        .all('attempt')
        .filter((x) => x.runId === id)
        .map(({ prompt, ...a }) => a),
    };
  }
  listRuns() {
    return this.store
      .all('run')
      .map(({ definition, context, ...r }) => r)
      .reverse();
  }
  listWorkers() {
    return this.store
      .all('worker')
      .map(({ credentialHash, ...w }) => ({
        ...w,
        online: this.now() - w.lastSeen <= this.peerSettings(w).offlineAfterSec * 1000,
        ...this.configResponse(w.id),
      }));
  }
  getAttempt(id: string) {
    const a = this.store.get('attempt', id);
    if (!a) throw new AppError('Attempt not found', 404);
    return a;
  }
  authenticateWorker(token: string) {
    const digest = hash(token);
    return this.store.all('worker').find((w) => {
      const b = Buffer.from(w.credentialHash ?? '');
      const a = Buffer.from(digest);
      return a.length === b.length && timingSafeEqual(a, b);
    });
  }
  registerWorker(input: Dict) {
    return this.store.tx(() => {
      safeId(input.workerId);
      if (
        !input.generation ||
        !Array.isArray(input.roles) ||
        !input.roles.length ||
        !input.roles.every((v: any) => typeof v === 'string')
      )
        throw new AppError('Worker generation and roles required');
      const old = this.store.get('worker', input.workerId);
      let credential: string | undefined;
      const initialCredential = () =>
        createHmac('sha256', this.pairingToken)
          .update(`${input.workerId}\0${input.generation}`)
          .digest('hex');
      if (old) {
        if (
          !input.credential &&
          input.pairingToken === this.pairingToken &&
          this.pairingToken &&
          old.pairingGeneration === input.generation
        )
          credential = initialCredential();
        if (hash(input.credential ?? credential ?? '') !== old.credentialHash)
          throw new AppError('Invalid worker credential', 401);
        if (
          old.generation !== input.generation &&
          this.now() - old.lastSeen < this.peerSettings(old).offlineAfterSec * 1000
        )
          throw new AppError('Worker already has a live generation', 409);
      } else {
        if (!this.pairingToken || input.pairingToken !== this.pairingToken)
          throw new AppError('Invalid pairing token', 401);
        credential = initialCredential();
      }
      const w = {
        ...old,
        id: input.workerId,
        name: String(input.name ?? input.workerId),
        roles: input.roles,
        generation: input.generation,
        pairingGeneration: old?.pairingGeneration ?? input.generation,
        credentialHash: old?.credentialHash ?? hash(credential!),
        lastSeen: this.now(),
        settingsVersion: old?.settingsVersion ?? 0,
        connection: old?.connection ?? this.connectionFor(input.workerId),
      };
      this.store.put('worker', w);
      return {
        workerId: w.id,
        ...(credential ? { credential } : {}),
        ...this.configResponse(w.id),
      };
    });
  }
  heartbeat(id: string, input: Dict) {
    return this.store.tx(() => {
      const w = this.requireWorker(id, input.generation);
      const current = this.getSettings();
      if (input.settingsVersion === current.version) {
        w.settingsVersion = current.version;
        w.connection = this.connectionFor(id);
      }
      w.lastSeen = this.now();
      this.store.put('worker', w);
      if (input.attemptId) {
        const a = this.getAttempt(input.attemptId);
        if (a.workerId !== id) throw new AppError('Attempt not owned by worker', 403);
        if (a.state === 'assigned' && a.generation === input.generation) {
          a.leaseUntil = this.now() + this.connectionFor(id).preSendLeaseSec * 1000;
          this.store.put('attempt', a);
        }
        if (typeof input.progressAt === 'number' && input.progressAt > a.progressAt) {
          a.progressAt = Math.min(this.now(), input.progressAt);
          this.store.put('attempt', a);
        }
      }
      return this.configResponse(id);
    });
  }
  private requireWorker(id: string, generation: string) {
    const w = this.store.get('worker', id);
    if (!w) throw new AppError('Worker not registered', 404);
    if (w.generation !== generation) throw new AppError('Stale worker generation', 409);
    return w;
  }
  startRun(workflowId: string, input: any, options: Dict = {}) {
    return this.store.tx(() => {
      const w = this.store.get('workflow', workflowId);
      if (!w) throw new AppError('Workflow not found', 404);
      if (!w.enabled) throw new AppError('Workflow disabled', 409);
      const triggerId = options.triggerId ?? 'manual',
        eventId = options.eventId ?? randomUUID();
      const receipt = this.store.receipt(workflowId, triggerId, eventId);
      if (receipt) return this.store.get('run', receipt.runId);
      const settings = this.getSettings(),
        limits = { ...settings.limits, ...w.definition.limits };
      const queued = this.store
        .all('run')
        .filter((r) => r.workflowId === workflowId && r.status === 'queued').length;
      const lineageId = options.lineageId ?? randomUUID(),
        lineage = this.store.get('lineage', lineageId) ?? {
          id: lineageId,
          count: 0,
          max: limits.maxChainRuns,
        };
      const trigger: Trigger | undefined = w.definition.triggers.find(
        (t: Trigger) => t.id === triggerId,
      );
      const id = randomUUID();
      let reason =
        trigger?.when && !evaluateRule(trigger.when, input ?? {})
          ? 'Trigger condition did not match'
          : '';
      if (queued >= limits.maxQueuedRuns) reason = 'Workflow queue is full';
      if (
        options.overlap === 'skip' &&
        this.store
          .all('run')
          .some((r) => r.workflowId === workflowId && (activeRun(r) || r.status === 'queued'))
      )
        reason = 'Trigger overlap policy: skip';
      if (lineage.count >= Math.min(lineage.max, limits.maxChainRuns))
        reason = 'Lineage workflow budget exhausted';
      const run = {
        id,
        workflowId,
        workflowVersion: w.version,
        definition: structuredClone(w.definition),
        settings: structuredClone(settings),
        execution: resolveExecution(settings.execution, w.definition.execution),
        limits,
        input: structuredClone(input),
        context: {
          input: structuredClone(input),
          steps: {},
          iteration: 1,
          feedback: null,
          previousOutput: '',
          lastOutput: '',
        },
        status: reason ? 'rejected' : 'queued',
        reason: reason || undefined,
        lineageId,
        cursor: w.definition.entry,
        stepCount: 0,
        repeatCounters: {},
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.store.put('run', run);
      this.store.saveReceipt(workflowId, triggerId, eventId, { runId: id });
      if (!reason) {
        lineage.count++;
        this.store.put('lineage', lineage);
      } else this.audit('trigger.rejected', { workflowId, triggerId, eventId, reason });
      this.dispatchRuns();
      return this.store.get('run', id);
    });
  }
  private dispatchRuns() {
    let runs = this.store.all('run');
    const maximum = this.getSettings().limits.globalConcurrentRuns;
    let occupied = runs.filter(activeRun).length;
    let last = this.store.get('meta', 'lastAdmitted')?.workflowId;
    while (occupied < maximum) {
      runs = this.store.all('run');
      const queued = runs.filter(
        (r) =>
          r.status === 'queued' &&
          runs.filter((x) => x.workflowId === r.workflowId && activeRun(x)).length <
            r.limits.perWorkflowConcurrentRuns,
      );
      if (!queued.length) break;
      const chosen = fairPick(queued, last)!;
      chosen.status = 'running';
      chosen.startedAt = this.now();
      this.store.put('run', chosen);
      this.advanceRun(chosen);
      last = chosen.workflowId;
      this.store.put('meta', { id: 'lastAdmitted', workflowId: last });
      occupied = this.store.all('run').filter(activeRun).length;
    }
  }
  private context(r: Dict) {
    return {
      ...r.context,
      run: { id: r.id, input: r.input, status: r.status, iteration: r.context.iteration },
      artifacts: Object.fromEntries(
        Object.entries(r.context.steps).map(([k, v]: [string, any]) => [
          k,
          { exists: !!v.artifactId, id: v.artifactId },
        ]),
      ),
    };
  }
  private advanceRun(r: Dict) {
    while (r.status === 'running' && !r.activeExecutionId) {
      if (++r.stepCount > r.limits.maxStepExecutions) {
        r.status = 'needsReview';
        r.reason = 'Step execution budget exhausted';
        break;
      }
      const n: FlowNode = r.definition.nodes.find((n: FlowNode) => n.id === r.cursor);
      if (!n) {
        r.status = 'needsReview';
        r.reason = 'Next node missing';
        break;
      }
      const execution: any = {
        id: randomUUID(),
        runId: r.id,
        nodeId: n.id,
        type: n.type,
        iteration: r.context.iteration,
        status: 'completed',
        startedAt: this.now(),
        endedAt: this.now(),
      };
      try {
        if (n.type === 'task' || n.type === 'review') {
          const input = render(
            n.input ?? (n.type === 'review' ? '{{lastOutput}}' : '{{input}}'),
            this.context(r),
          );
          const review =
            n.type === 'review'
              ? `\n\nReview criteria:\n${n.rubric ?? ''}\nReturn ONLY a JSON object with passed (boolean), score (number 0 through 100), issues (array of strings).`
              : '';
          const prompt = [n.skill ?? '', input].filter((x) => x !== '').join('\n\n') + review;
          if (!prompt.length || prompt.length > 150000)
            throw new AppError('Prompt must contain 1..150000 UTF-16 code units');
          const settings = resolveExecution(r.execution, n.timeout);
          execution.status = 'queued';
          delete execution.endedAt;
          this.store.put('job', {
            id: randomUUID(),
            runId: r.id,
            workflowId: r.workflowId,
            nodeExecutionId: execution.id,
            nodeId: n.id,
            role: n.role ?? 'default',
            prompt,
            execution: settings,
            state: 'queued',
            createdAt: this.now(),
          });
          r.activeExecutionId = execution.id;
        } else if (n.type === 'condition') {
          const next =
            (n.cases ?? []).find((c) => Boolean(evaluateRule(c.when, this.context(r))))?.next ??
            n.otherwise;
          if (!next) {
            r.status = 'needsReview';
            r.reason = 'No condition matched and no otherwise branch';
          } else r.cursor = next;
        } else if (n.type === 'repeat') {
          const count = r.repeatCounters[n.id] ?? 1;
          if (count >= (n.maxIterations ?? 3)) {
            r.status = 'needsReview';
            r.reason = `Repeat budget exhausted at ${n.id}`;
          } else {
            r.repeatCounters[n.id] = count + 1;
            r.context.iteration++;
            r.context.feedback = r.context.review ?? null;
            r.context.previousOutput = r.context.lastOutput;
            delete r.context.review;
            const clear = new Set<string>();
            const walk = (id: string) => {
              if (clear.has(id) || id === n.id) return;
              clear.add(id);
              const child = r.definition.nodes.find((x: FlowNode) => x.id === id);
              if (child) for (const to of edges(child, false)) walk(to);
            };
            walk(n.target!);
            for (const id of clear) delete r.context.steps[id];
            const retained = new Set(Object.values(r.context.steps).map((v: any) => v.artifactId));
            if (!retained.has(r.context.lastTaskArtifactId)) delete r.context.lastTaskArtifactId;
            if (!retained.has(r.context.lastArtifactId)) {
              delete r.context.lastArtifactId;
              r.context.lastOutput = '';
            }
            delete r.outputArtifactId;
            r.cursor = n.target!;
            if ((n.delaySec ?? 0) > 0) {
              execution.status = 'waiting';
              execution.resumeTarget = n.target;
              execution.dueAt = this.now() + n.delaySec! * 1000;
              r.activeExecutionId = execution.id;
              delete execution.endedAt;
            }
          }
        } else if (n.type === 'delay') {
          execution.status = 'waiting';
          execution.dueAt = n.until ? Date.parse(n.until) : this.now() + (n.delaySec ?? 0) * 1000;
          execution.resumeTarget = n.next;
          r.activeExecutionId = execution.id;
          delete execution.endedAt;
        } else if (n.type === 'end') {
          const chosen = n.outputNodeId
            ? r.context.steps[n.outputNodeId]?.artifactId
            : (r.context.lastTaskArtifactId ?? r.context.lastArtifactId);
          if (n.outputNodeId && !chosen)
            throw new AppError('End output node has no current result');
          r.status = n.outcome ?? 'succeeded';
          r.endedAt = this.now();
          r.outputArtifactId = chosen;
          if (chosen) r.context.finalOutput = this.getArtifact(chosen).text;
        } else if (n.next) r.cursor = n.next;
        else throw new AppError('Start must have next');
        if ((n.type === 'task' || n.type === 'review') && !n.next)
          throw new AppError('Task needs next');
      } catch (e) {
        r.status = 'needsReview';
        r.reason = (e as Error).message;
        execution.status = 'failed';
      }
      this.store.put('execution', execution);
      r.updatedAt = this.now();
      this.store.put('run', r);
      if (r.status === 'succeeded') this.emitWorkflowCompletion(r);
    }
    this.store.put('run', r);
  }
  claim(workerId: string, generation: string): AttemptJob | null {
    return this.store.tx(() => {
      this.tick();
      const w = this.requireWorker(workerId, generation);
      const existing = this.store
        .all('attempt')
        .find((a) => a.workerId === workerId && activeAttempt(a));
      if (existing)
        return existing.generation === generation && existing.state === 'assigned'
          ? existing
          : null;
      const jobs = this.store
        .all('job')
        .filter(
          (j) =>
            j.state === 'queued' &&
            w.roles.includes(j.role) &&
            this.store.get('run', j.runId)?.status === 'running',
        );
      const last = this.store.get('meta', 'lastDispatched')?.workflowId;
      const j = fairPick(jobs, last);
      if (!j) return null;
      const a = {
        id: randomUUID(),
        jobId: j.id,
        runId: j.runId,
        nodeExecutionId: j.nodeExecutionId,
        nodeId: j.nodeId,
        workerId,
        generation,
        fence: randomUUID(),
        state: 'assigned',
        prompt: j.prompt,
        execution: j.execution,
        createdAt: this.now(),
        leaseUntil: this.now() + this.connectionFor(workerId).preSendLeaseSec * 1000,
        progressAt: this.now(),
        seq: 0,
        eventIds: [],
      };
      this.store.put('attempt', a);
      j.state = 'assigned';
      j.attemptId = a.id;
      this.store.put('job', j);
      this.store.put('meta', { id: 'lastDispatched', workflowId: j.workflowId });
      return a;
    });
  }
  sendIntent(id: string, input: Dict) {
    this.tick();
    return this.store.tx(() => {
      const a = this.getAttempt(id);
      this.requireWorker(a.workerId, input.generation);
      if (a.fence !== input.fence || a.generation !== input.generation)
        throw new AppError('Stale fence or generation', 409);
      if (['sending', 'running', 'uncertain', 'complete', 'partial'].includes(a.state))
        return { authorized: false, state: a.state };
      if (a.state !== 'assigned' || a.leaseUntil < this.now())
        throw new AppError('Attempt lease expired or state invalid', 409);
      const r = this.store.get('run', a.runId);
      if (r.status !== 'running') throw new AppError('Run not running', 409);
      a.state = 'sending';
      a.sentAt = this.now();
      a.progressAt = this.now();
      this.store.put('attempt', a);
      return { authorized: true, state: a.state };
    });
  }
  event(id: string, input: Dict) {
    return this.store.tx(() => {
      const a = this.getAttempt(id);
      this.requireWorker(a.workerId, input.generation);
      if (!input.eventId || !Number.isSafeInteger(input.seq) || input.seq < 1)
        throw new AppError('eventId and positive seq required');
      if (a.eventIds.includes(input.eventId) || input.seq <= a.seq)
        return { accepted: true, duplicate: true };
      a.seq = input.seq;
      a.eventIds.push(input.eventId);
      if (a.eventIds.length > 200) a.eventIds.shift();
      if (['complete', 'partial', 'failed', 'expired', 'resolved'].includes(a.state)) {
        this.store.put('attempt', a);
        return { accepted: true, ignored: true };
      }
      if (input.state === 'notSent') {
        if (a.state !== 'assigned' || a.sentAt)
          throw new AppError('notSent only valid before authorization', 409);
        a.state = 'failed';
        a.reason = input.message ?? 'Preparation failed before send';
        this.store.put('attempt', a);
        const job = this.store.get('job', a.jobId);
        job.state = 'failed';
        this.store.put('job', job);
        const run = this.store.get('run', a.runId);
        if (!['cancelled', 'succeeded', 'failed'].includes(run.status)) {
          run.status = 'needsReview';
          run.reason = a.reason;
          this.store.put('run', run);
        }
        return { accepted: true };
      }
      if (!['sending', 'running', 'uncertain'].includes(a.state))
        throw new AppError('Cannot report running before send authorization', 409);
      if (input.state === 'uncertain') this.markUncertain(a, input.message ?? 'Worker uncertain');
      else if (input.state === 'running') {
        if (a.state !== 'uncertain') a.state = 'running';
        a.progressAt = Math.min(this.now(), input.progressAt ?? a.progressAt);
        this.store.put('attempt', a);
      } else if (input.state === 'failed' || input.state === 'partial') {
        a.state = input.state;
        this.store.put('attempt', a);
        const r = this.store.get('run', a.runId);
        if (!['cancelled', 'failed', 'succeeded'].includes(r.status)) {
          r.status = 'needsReview';
          r.reason = input.message ?? input.state;
          this.store.put('run', r);
        }
      } else throw new AppError('Invalid event state');
      return { accepted: true };
    });
  }
  setAttemptMetadata(id: string, metadata: Dict) {
    const a = this.getAttempt(id);
    a.metadata = metadata;
    this.store.put('attempt', a);
  }
  private markUncertain(a: Dict, reason: string) {
    a.state = 'uncertain';
    a.reason = reason;
    this.store.put('attempt', a);
    const r = this.store.get('run', a.runId);
    if (r && r.activeExecutionId === a.nodeExecutionId && r.status === 'running') {
      r.status = 'uncertain';
      r.reason = reason;
      this.store.put('run', r);
    }
  }
  completeText(id: string, text: string, status: 'complete' | 'partial', metadata: Dict) {
    const bytes = Buffer.from(text, 'utf8'),
      digest = hash(bytes),
      path = join(this.artifactsDir, `${digest}.md`);
    if (!existsSync(path)) {
      const temp = path + '.' + randomUUID() + '.tmp';
      writeFileSync(temp, bytes, { flush: true });
      renameSync(temp, path);
    }
    return this.completeArtifact(
      id,
      { id: digest, path, sha256: digest, byteLength: bytes.length },
      status,
      metadata,
    );
  }
  completeArtifact(
    id: string,
    artifact: Dict,
    status: 'complete' | 'partial',
    metadata: Dict = {},
  ) {
    this.tick();
    return this.store.tx(() => {
      const a = this.getAttempt(id);
      if (a.resultHash) {
        if (a.resultHash !== artifact.sha256 || a.resultStatus !== status)
          throw new AppError('Result conflict', 409);
        return { accepted: true, artifactId: a.artifactId };
      }
      if (!['sending', 'running', 'uncertain', 'partial'].includes(a.state))
        throw new AppError('No authorized send for this result', 409);
      this.store.put('artifact', artifact);
      a.resultHash = artifact.sha256;
      a.resultStatus = status;
      a.artifactId = artifact.id;
      a.state = status;
      a.completedAt = this.now();
      a.metadata = { ...a.metadata, ...metadata };
      this.store.put('attempt', a);
      const j = this.store.get('job', a.jobId);
      j.state = 'completed';
      this.store.put('job', j);
      const r = this.store.get('run', a.runId);
      const x = this.store.get('execution', a.nodeExecutionId);
      x.status = status;
      x.endedAt = this.now();
      x.artifactId = artifact.id;
      this.store.put('execution', x);
      if (
        r.activeExecutionId !== a.nodeExecutionId ||
        ['succeeded', 'failed', 'cancelled'].includes(r.status)
      )
        return { accepted: true, artifactId: artifact.id };
      if (status === 'partial') {
        r.status = 'needsReview';
        r.reason = 'Partial output';
        this.store.put('run', r);
        return { accepted: true, artifactId: artifact.id };
      }
      const n: FlowNode = r.definition.nodes.find((n: FlowNode) => n.id === a.nodeId);
      const text = readFileSync(artifact.path, 'utf8');
      const result: Dict = {
        text,
        artifactId: artifact.id,
        status: 'complete',
        nodeExecutionId: x.id,
        iteration: x.iteration,
      };
      if (n.type === 'review') {
        try {
          const review = JSON.parse(text);
          if (
            typeof review.passed !== 'boolean' ||
            typeof review.score !== 'number' ||
            !Number.isFinite(review.score) ||
            review.score < 0 ||
            review.score > 100 ||
            !Array.isArray(review.issues) ||
            !review.issues.every((v: any) => typeof v === 'string')
          )
            throw new Error('Invalid review schema');
          result.review = review;
          r.context.review = review;
        } catch {
          r.status = 'needsReview';
          r.reason = 'Review must be valid JSON with passed, score (0..100), issues';
          this.store.put('run', r);
          return { accepted: true, artifactId: artifact.id };
        }
      }
      r.context.steps[a.nodeId] = result;
      r.context.lastOutput = text;
      r.context.lastArtifactId = artifact.id;
      if (n.type === 'task') r.context.lastTaskArtifactId = artifact.id;
      r.outputArtifactId = artifact.id;
      r.cursor = n.next;
      delete r.activeExecutionId;
      if (r.status === 'uncertain') r.status = 'running';
      delete r.reason;
      this.store.put('run', r);
      if (r.status === 'running') this.advanceRun(r);
      this.dispatchRuns();
      return { accepted: true, artifactId: artifact.id };
    });
  }
  getArtifact(id: string) {
    safeId(id);
    const a = this.store.get('artifact', id);
    if (!a) throw new AppError('Artifact not found', 404);
    return { ...a, text: readFileSync(a.path, 'utf8') };
  }
  resolveAttempt(id: string, action: string, note: string) {
    return this.store.tx(() => {
      if (!['abandon', 'notSent'].includes(action) || typeof note !== 'string' || !note.trim())
        throw new AppError('Resolution action and inspection note required');
      const a = this.getAttempt(id);
      if (a.state === 'resolved') return { resolved: true, state: 'resolved' };
      if (!activeAttempt(a)) throw new AppError('Only active attempts can be resolved', 409);
      a.state = 'resolved';
      a.resolution = action;
      a.resolutionNote = note;
      a.resolvedAt = this.now();
      this.store.put('attempt', a);
      const j = this.store.get('job', a.jobId),
        r = this.store.get('run', a.runId);
      if (action === 'notSent' && !['cancelled', 'succeeded', 'failed'].includes(r.status)) {
        j.state = 'queued';
        delete j.attemptId;
        r.status = 'running';
        delete r.reason;
      } else {
        j.state = 'cancelled';
        if (!['succeeded', 'failed'].includes(r.status)) {
          r.status = 'cancelled';
          r.endedAt = this.now();
        }
      }
      this.store.put('job', j);
      this.store.put('run', r);
      this.audit('attempt.resolved', { attemptId: id, action, note });
      this.dispatchRuns();
      return { resolved: true, state: 'resolved' };
    });
  }
  controlRun(id: string, action: string) {
    return this.store.tx(() => {
      const r = this.store.get('run', id);
      if (!r) throw new AppError('Run not found', 404);
      if (['succeeded', 'failed', 'cancelled', 'rejected'].includes(r.status))
        throw new AppError('Run already terminal', 409);
      if (action === 'pause') r.status = 'paused';
      else if (action === 'stop' || action === 'cancel') {
        r.status = 'cancelled';
        r.endedAt = this.now();
      } else if (action === 'resume') {
        const a = this.store.all('attempt').find((a) => a.runId === id && activeAttempt(a));
        if (a && ['sending', 'running', 'uncertain'].includes(a.state))
          throw new AppError('Sent attempt requires reconciliation, not replay', 409);
        const execution = r.activeExecutionId && this.store.get('execution', r.activeExecutionId);
        if (execution?.status === 'complete') {
          const n = r.definition.nodes.find((n: FlowNode) => n.id === execution.nodeId);
          if (n.type === 'review' && !r.context.steps[n.id])
            throw new AppError('Invalid review needs a corrected workflow/new run', 409);
          r.cursor = n.next;
          delete r.activeExecutionId;
        }
        if (execution) {
          const job = this.store.all('job').find((j) => j.nodeExecutionId === execution.id);
          if (job?.state === 'failed') {
            const previous = job.attemptId && this.store.get('attempt', job.attemptId);
            if (previous?.sentAt)
              throw new AppError('Sent failure requires explicit reconciliation', 409);
            job.state = 'queued';
            delete job.attemptId;
            this.store.put('job', job);
          }
        }
        r.status = 'running';
        delete r.reason;
      } else throw new AppError('Unknown control action');
      this.store.put('run', r);
      if (r.status === 'running') this.advanceRun(r);
      this.dispatchRuns();
      return r;
    });
  }
  private nextSchedule(t: Trigger, after: number) {
    return t.intervalSec
      ? after + t.intervalSec * 1000
      : CronExpressionParser.parse(t.cron!, {
          currentDate: new Date(after),
          tz: t.timezone ?? 'Asia/Saigon',
        })
          .next()
          .toDate()
          .getTime();
  }
  emitEvent(event: Dict) {
    return this.store.tx(() => {
      if (!event.id || !event.type) throw new AppError('Event id/type required');
      const runs = [];
      for (const w of this.listWorkflows().filter((w) => w.enabled))
        for (const t of w.definition.triggers as Trigger[])
          if (
            t.type === 'event' &&
            t.eventType === event.type &&
            (!t.when || evaluateRule(t.when, event.payload ?? {}))
          )
            runs.push(
              this.startRun(w.id, event.payload, {
                eventId: event.id,
                triggerId: t.id,
                overlap: t.overlap,
              }),
            );
      return runs;
    });
  }
  private emitWorkflowCompletion(r: Dict) {
    if (r.completionEmitted) return;
    r.completionEmitted = true;
    this.store.put('run', r);
    const data = {
      workflowId: r.workflowId,
      runId: r.id,
      status: r.status,
      output: r.context.finalOutput ?? r.context.lastOutput,
      review: r.context.review,
      artifactId: r.outputArtifactId,
    };
    for (const w of this.listWorkflows().filter((w) => w.enabled))
      for (const t of w.definition.triggers as Trigger[])
        if (
          t.type === 'workflow' &&
          t.sourceWorkflowId === r.workflowId &&
          (!t.when || evaluateRule(t.when, data))
        )
          this.startRun(w.id, data, {
            eventId: r.id,
            triggerId: t.id,
            lineageId: r.lineageId,
            overlap: t.overlap,
          });
  }
  tick() {
    return this.store.tx(() => {
      const now = this.now();
      for (const a of this.store.all('attempt')) {
        if (a.state === 'assigned' && a.leaseUntil < now) {
          a.state = 'expired';
          this.store.put('attempt', a);
          const j = this.store.get('job', a.jobId);
          if (j.attemptId === a.id) {
            j.state = 'queued';
            delete j.attemptId;
            this.store.put('job', j);
          }
        } else if (['sending', 'running'].includes(a.state)) {
          const w = this.store.get('worker', a.workerId);
          if (!w || now - w.lastSeen > this.peerSettings(w).offlineAfterSec * 1000)
            this.markUncertain(a, 'Worker heartbeat lost after send');
        }
      }
      for (const r of this.store.all('run').filter((r) => r.status === 'running')) {
        const x = r.activeExecutionId && this.store.get('execution', r.activeExecutionId);
        const node = x && r.definition.nodes.find((n: FlowNode) => n.id === x.nodeId);
        const j = x && this.store.all('job').find((j) => j.nodeExecutionId === x.id);
        const a = j?.attemptId && this.store.get('attempt', j.attemptId);
        const policy = j?.execution ?? resolveExecution(r.execution, node?.timeout);
        let reason = '';
        if (
          r.execution.workflowTotalTimeoutSec &&
          now - r.startedAt > r.execution.workflowTotalTimeoutSec * 1000
        )
          reason = 'Workflow total timeout';
        else if (
          x &&
          policy.stepTotalTimeoutSec &&
          now - x.startedAt > policy.stepTotalTimeoutSec * 1000
        )
          reason = 'Step total timeout';
        else if (
          a &&
          policy.noProgressTimeoutSec &&
          now - a.progressAt > policy.noProgressTimeoutSec * 1000
        )
          reason = 'No progress timeout';
        if (reason && r.lastWarning !== reason) {
          r.lastWarning = reason;
          this.audit('timeout', { runId: r.id, nodeId: x?.nodeId, reason });
          const action =
            reason === 'Workflow total timeout' ? r.execution.timeoutAction : policy.timeoutAction;
          if (action === 'pause') {
            r.status = 'paused';
            r.reason = reason;
          }
          if (action === 'stop') {
            r.status = 'cancelled';
            r.reason = reason;
            r.endedAt = now;
          }
          this.store.put('run', r);
        }
        if (r.status === 'running' && x?.status === 'waiting' && x.dueAt <= now) {
          x.status = 'completed';
          x.endedAt = now;
          this.store.put('execution', x);
          r.cursor = x.resumeTarget;
          delete r.activeExecutionId;
          this.store.put('run', r);
          this.advanceRun(r);
        }
      }
      for (const s of this.store.all('schedule')) {
        const w = this.store.get('workflow', s.workflowId),
          t: Trigger | undefined = w?.definition.triggers.find(
            (t: Trigger) => t.id === s.triggerId && t.type === 'schedule',
          );
        if (!t || !w.enabled || s.nextAt > now) continue;
        let due = s.nextAt;
        const late = now - due > 1000;
        if (late) {
          if (t.missed !== 'catchUpLatest') {
            this.audit('schedule.skipped', { workflowId: w.id, triggerId: t.id, scheduledAt: due });
            s.nextAt = this.nextSchedule(t, now);
            this.store.put('schedule', s);
            continue;
          }
          due = t.intervalSec
            ? due + Math.floor((now - due) / (t.intervalSec * 1000)) * t.intervalSec * 1000
            : CronExpressionParser.parse(t.cron!, {
                currentDate: new Date(now + 1),
                tz: t.timezone ?? 'Asia/Saigon',
              })
                .prev()
                .toDate()
                .getTime();
        }
        this.startRun(w.id, t.input ?? { scheduledAt: new Date(due).toISOString() }, {
          eventId: `schedule:${due}`,
          triggerId: t.id,
          overlap: t.overlap,
        });
        s.nextAt = this.nextSchedule(t, now);
        this.store.put('schedule', s);
      }
      this.dispatchRuns();
    });
  }
  snapshot() {
    return {
      settings: this.getSettings(),
      workflows: this.listWorkflows(),
      runs: this.listRuns(),
      workers: this.listWorkers(),
      audit: this.store.all('audit').slice(-100).reverse(),
    };
  }
}
