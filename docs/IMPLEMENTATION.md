# Agent Flow implementation contract

Approved plan: 2026-11-12, Manager/Worker + embedded Node-RED and configurable timing/workflows.

## Tasks

1. Shared settings, graph validation and durable Manager engine. Owner: root.
2. HTTP Manager API and streaming artifacts. Owner: root.
3. Worker agent and strict ChatGPT browser adapter. Owner: worker implementer.
4. Embedded passive Node-RED editor, dashboard and example graphs. Owner: UI implementer.
5. Integration tests, review, Windows launch scripts and operator documentation. Owner: root.

## Shared contracts

See src/shared/types.ts. Each implementation owns only its directory and named tests.
No paid AI API, no Codex dependency, no anti-CAPTCHA, stealth, token export or rate-limit account switching.
One Worker has one in-flight attempt. Network retry never repeats a browser send.
Node-RED nodes are inert; Manager SQLite is the only execution authority. Deploy saves drafts, Publish activates a validated immutable graph snapshot.
Node.js 22.14+, TypeScript, Express, node:sqlite; compiled sources import .js extensions.

### Manager API (JSON except streamed result)

Admin authentication: Bearer admin token OR httpOnly af_admin cookie (login endpoint).
Worker authentication: Bearer worker credential issued at pairing. Auth token hashes stored server-side.

- POST /api/v1/workers/register {workerId,name,roles:string[],generation,pairingToken?,credential?} -> {credential?,workerId,settingsVersion,connection}
- POST /api/v1/workers/:id/heartbeat {generation,settingsVersion,attemptId?,progressAt?} -> {settingsVersion,connection}
- POST /api/v1/workers/:id/claim {generation,waitSeconds?} -> {attempt:AttemptJob|null,settingsVersion,connection}
- POST /api/v1/attempts/:id/send-intent {generation,fence} -> {authorized:boolean,state:string}. First valid request only grants authority; duplicate never grants again.
- POST /api/v1/attempts/:id/events {generation,eventId,seq,state:'running'|'uncertain'|'partial'|'failed',progressAt?,message?} -> {accepted:boolean}
- PUT /api/v1/attempts/:id/result?status=complete|partial, Content-Type:application/octet-stream, X-Content-SHA256:<hex>, X-Result-Metadata:<base64 JSON> -> {accepted:boolean,artifactId:string}
- GET /api/v1/attempts/:id -> attempt status (owner or admin).
  Late results can be uploaded using same credential and a NEW generation, without a new send grant. Existing unknown attempt occupies Worker until reconciled or explicitly resolved.
  Progress events dedup by eventId + sequence. Results dedup by attemptId + sha256.

### Editor integration

src/editor/index.ts exports async mountEditor({app,server,dataDir,adminToken,authorize,engine}): Promise<{close():Promise<void>}>.
engine exposes publish(WorkflowDefinition), listWorkflows(), getSettings(), updateSettings(partial), listRuns(), getRun(id), listWorkers(), startRun(workflowId,input,{eventId?,triggerId?}), controlRun(id,action), getArtifact(id), snapshot().
UI calls Manager HTTP routes defined by root; mountEditor registers /flows plus /api/v1/editor/drafts and /api/v1/editor/publish. Publish compiles selected Node-RED tab to WorkflowDefinition via editor converter then engine.publish. Normal custom-node runtime does nothing.

### Browser adapter

src/worker/browser.ts exports BrowserDriver interface and ChatGptDriver implementation. start/observe are separated from sending authority; journal before exactly one send gesture; no automatic resubmit. Adapter should reuse/adapt pinned browser-ai-bridge locators/dom logic with MIT attribution (commit de112345daecaf6f2c6d480099de783da7873737), not call its retrying /api/ask path.
Driver result is raw UTF-8 Markdown plus raw ordered message parts/metadata; only terminal assistant reply in submitted user's branch is complete. No trim, cleanup or fabricated empty response. Uncertain/partial never advances graph.

## Initial defaults and semantics

Connection: longPollWaitSec25,longPollHttpTimeoutSec35,apiRequestTimeoutSec30,heartbeatIntervalSec10,offlineAfterSec30,preSendLeaseSec60,artifactTransferIdleSec60.
Execution: noProgressTimeoutSec600,stepTotalTimeoutSec=null,workflowTotalTimeoutSec=null,timeoutAction='warn'.
Limits: globalConcurrentRuns2,perWorkflowConcurrentRuns1,maxQueuedRuns100,maxStepExecutions100,maxChainRuns10.
Repeat.maxIterations3 counts initial pass; all cycles require explicit Repeat and durable budgets.
Timezone Asia/Saigon. Overlap queue; missed schedule skip (catchUpLatest optional). Trigger dedup excludes graph version.
Connection globals -> worker overrides; execution globals -> workflow -> node. UI import/export settings.
Never automatically rerun uncertain work. VM live-memory snapshot rollback is unsupported; restored/cold-start workers reconcile and never replay old sending journals.
