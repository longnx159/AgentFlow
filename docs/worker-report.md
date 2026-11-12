# Worker implementation

Run from the repository with Node.js 22.14+:

```powershell
$env:AF_MANAGER_URL = 'http://PCA:6060'
$env:AF_WORKER_ID = 'PCB'
$env:AF_WORKER_NAME = 'PCB writing worker'
$env:AF_WORKER_ROLES = 'default,writer,reviewer'
$env:AF_PAIRING_TOKEN = '<Manager pairing token>'
$env:AF_WORKER_DATA_DIR = './data/worker-PCB'
npm run worker
```

The status/configuration UI listens on `http://127.0.0.1:6061`. Pair there if no token was supplied. The first registration stores the issued Worker credential in the local SQLite journal. A pending pairing token and initial generation stay local until that credential is durable, so a cold restart after a lost pairing response can recover the same credential. Later calls use Bearer authentication; registration accepts that Bearer credential too. Saved credentials are scoped to Manager URL and Worker ID. Tokens and credentials are omitted from status/config responses. The UI is bound to loopback, checks mutation origins, and has no third-party resources.

Chrome opens with a separate persistent profile. Sign in manually inside that Chrome window. No attempt is claimed until the browser can prove it has an authenticated session. Login/CAPTCHA/2FA are human actions. The automation flag remains enabled; there is no stealth, CAPTCHA bypass, API key, account rotation, provider fallback, or paid AI API.

Environment options: `AF_MANAGER_URL`, `AF_WORKER_ID`, `AF_WORKER_NAME`, comma-separated `AF_WORKER_ROLES` (default `default`), `AF_PAIRING_TOKEN`, `AF_WORKER_DATA_DIR`, `CHROME_USER_DATA_DIR`, `HEADLESS`, `CHROME_PATH`, `CDP_PORT` (default 9223), `AF_CHROME_OFFSCREEN`, and `AF_WORKER_UI_PORT` (default 6061). `AF_WORKER_CONFIG` can point to a JSON file with the corresponding camelCase fields defined in `src/worker/config.ts`; environment values take precedence. UI configuration saves Manager URL, name, and roles in local SQLite for the next restart. Use a separate data directory/profile/CDP port for each Worker. Default mode is headed; start with `HEADLESS=false` for human login. After login, `HEADLESS=offscreen` (or `AF_CHROME_OFFSCREEN=true`) moves the headed window offscreen. `HEADLESS=true` requires an already-authenticated profile.

## Durability and strict extraction

`WorkerJournal` uses SQLite WAL plus synchronous FULL and enforces one active attempt with a database uniqueness constraint. It stores the credential, jobs, receipts, pending deduplicated events, progress, exact raw results, hashes, and ACKs locally. Before requesting send authority, the Worker durably marks the attempt `sending`. Before the single browser click, a synchronous journal commit is required again. A duplicate/ambiguous grant, click failure, missing receipt, lost browser, or unknown completion moves to observation/reconciliation only. No Enter fallback and no browser resend path exist. A cold `sending` journal only observes; an unknown attempt continues occupying the slot.

Before observing active work, the Worker reads the Manager's attempt state. An explicit operator `resolved` state releases the local slot while retaining receipt, result, and history; it never grants another send for that attempt. An expired pre-send claim also releases safely. Network failures while the local claim is still known unsent preserve that claim. If browser preparation fails before send authority, a durable `notSent` event puts the Manager run into manual review; local release waits for its ACK. A lost event ACK retries the same event ID and sequence without observing or sending. An operator can correct the browser and Resume the run to create a new attempt.

The browser request observer captures the exact submitted user-message ID from that tab's matching outgoing conversation request and immediately journals it. Later network receipts are also journaled after ambiguous click errors. Reads use `/api/auth/session` and the read-only conversation endpoint inside `page.evaluate`; the access token stays in browser JavaScript memory and is never returned to Node, persisted, or sent to Manager. A known conversation can reopen for read-only reconciliation after a cold restart. If the tab/receipt cannot be recovered, the Worker stays uncertain and does not infer a sent message merely from matching prompt text.

Completion requires a text final assistant reply on the submitted user's current ancestry branch, `finished_successfully`, and `end_turn=true`. Analysis, tool-directed output, sibling branches, missing IDs, missing parts, empty output, multimodal non-text parts, DOM stability, hidden buttons, and missing selectors cannot fabricate a complete result. Ordered string parts are concatenated with **no inserted separator**, trimming, citation stripping, whitespace cleanup, or Markdown rewriting. The original ordered parts and extraction evidence are preserved in the local journal and posted to the Manager metadata endpoint; raw UTF-8 Markdown is streamed in 64KiB chunks with SHA-256. Metadata stays out of headers. Lost upload ACKs retry identical bytes/hash, never another browser send.

A finished reply whose raw finish details report `max_tokens` or `length` is terminal partial. Its exact text, ordered parts and finish details are uploaded with status `partial` for manual review, never represented as complete. In-progress partial snapshots stay in the observer and retain the slot.

Registration, long polling, heartbeats, and uploads reconnect independently of browser generation. Long-poll timeout and normal API timeout are separate; artifact transfer uses a resettable idle deadline. Heartbeats continue during long polling and browser observation. Returned connection settings/version are adopted and acknowledged. Streaming snapshots update progress and send `running` events; a streaming snapshot does not send Manager's terminal `partial` event. No six-minute generation cutoff exists. The effective attempt's configurable no-progress timer emits warnings while observation continues. Explicit total/pause/stop policies remain Manager authority.

## Local async observer

- `POST /api/local/start` returns 202 immediately and wakes the background connection/claim/observer loop.
- `GET /api/local/status` returns connection state, current attempt and progress.
- `GET /api/local/attempts/:id` returns the durable local receipt/state/result record.
- `GET /api/local/attempts/:id/result` returns current exact raw Markdown, or 202 while no text exists.
- `POST /api/local/pair {pairingToken}` pairs asynchronously.
- `POST /api/local/config {managerUrl,name,roles}` saves the next-start configuration.

## Validation and limits

Tests use actual local SQLite and actual localhost HTTP, including the real Manager HTTP/Engine for preparation failure and manual resume. Browser tests inject only the browser/session boundary; no actual ChatGPT submission is made. They cover committed sending before input, one gesture after ambiguous clicks, exact user receipt, sibling/analysis/tool/unfinished rejection, raw text preservation, missing-receipt cold restart, duplicate grant rejection, one occupied slot, durable reopen, ACK-loss upload retry under a new generation, indefinite streaming progress, authentication/readiness before claim, cold pairing ACK loss, asynchronous 202 status, cross-origin mutation rejection, settings parsing, explicit operator resolution, expired pre-send leases, transient pre-send status failures, durable notSent ACK retries, and resetting artifact idle timeout on response progress.

Verification: `npx tsx --test test/browser*.test.ts test/worker*.test.ts`, `npm test`, and `npm run check`. Node 22 emits its expected experimental SQLite warning. Full-suite verification is reported by the integrating agent after all owned changes land.

Real ChatGPT/Chrome behavior has not been validated against a live logged-in account in this session. DOM/private request schemas and endpoints can change. Unsupported shapes fail closed as uncertain. An interrupted send before its user-message receipt becomes durable cannot be automatically attributed; manual reconciliation is required and no resend is attempted. Live-memory VM rollback is unsupported. The Worker retains raw output in SQLite and memory before upload; generation is not incrementally written to disk as a streaming artifact. Browser Chrome is kept alive when the Worker exits so an in-progress generation can continue.

Pinned upstream attribution: `vendor/browser-ai-bridge/README.md` and MIT `LICENSE`, commit `de112345daecaf6f2c6d480099de783da7873737`. Only locators and DOM/page-session read techniques were adapted; upstream retrying APIs/helpers and cleanup paths are not called.
