# Implementation ledger — plan: docs/IMPLEMENTATION.md

- Workspace inspected: empty, no Git repository. Work stays in the explicitly selected workspace; no existing branch needs isolation.
- Runtime verified: Node 22.14.0 supports node:sqlite; npm registry Node-RED 5.0.9 requires Node >=22.9.
- Ruling: independently owned UI and Worker modules may be implemented concurrently under the written shared contract; root owns core/API and integration. No shared file edits by implementers.
- Ruling: use a strict adapter based on pinned upstream browser logic rather than invoking upstream retrying API; this is necessary for single-send semantics. Upstream attribution must accompany reused code.
- Core complete: immutable graphs/settings/Skill snapshots, FIFO+round-robin admission/role dispatch, durable timers and bounded repeat/lineage logic.
- Manager API complete: authenticated worker/admin routes, streamed hash-verified raw artifacts, idempotent receipts and explicit operator resolution.
- Worker complete: pinned upstream attribution, isolated Chrome, one gesture, durable user receipts, long-response observer and safe ACK/restart handling.
- Editor complete: passive allowlisted Node-RED nodes, publish boundary, dashboard, basic rule builder, settings import/export and operator recovery UI.
- Review fixed with RED→GREEN regression tests: preparation failures and pre-send network failures; overdue Delay timeout ordering and node overrides; stale Repeat output pointers; explicit unknown-attempt resolution on both peers.
- Additional integration fixes verified: Node-RED Bearer does not shadow valid admin cookie; duplicate progress ACK; initial pairing ACK loss; End chooses candidate output; timer checks on send/result boundaries; schedule input/when admission.
- Browser smoke: real Chrome + Manager/Node-RED UI + 2 HTTP Worker agents, one review/refinement loop, raw output preserved, settings saved. External AI boundary is a fixture.
- Fleet test: 10 independent agents on localhost, 12 two-step runs, 24 unique sends, global parallel cap4 respected. This is not a real VM deployment.
- Ruling: first login is headed; HEADLESS=offscreen is supported after manual login. Safer initial profile setup costs one manual login, not manual task transfer.
- Ruling: retain source/workspace in place because no Git repo or remote exists; no commit, push, PR or OS/firewall change was attempted.
- Final verification: `npm test` 62/62 PASS; `npm run check` PASS; `npm run build` PASS; `node dist/scripts/smoke.js` PASS (compiled Manager + Worker pages, Writer/Review loop, raw output, settings save). Logs: test-results/unit.log; screenshot: test-results/manager.png.
- Compiled asset packaging fixed RED→GREEN: Worker public page returned404 before asset copying; compiled smoke now verifies both Worker pages200 and Manager UI flow.
- Raw message metadata (including citation references) is retained in addition to ordered text parts and finish details.
- No deferred Important findings remain from independent code review. Node-RED OAuth expiry timers require CLI shutdown to exit the process; main entrypoint already awaits cleanup then exits. No live ChatGPT account or VM fleet has been tested.
