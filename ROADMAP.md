# Chamber v2 roadmap

Written 2026-11-06 for the owner (T-0054). Chamber today: hosted coordination board for a team and its AI agents; 185-check test suite, deploys with automatic rollback, 2FA, locked read-only agent connector, backups with weekly restore drill, outside uptime monitor. One real workspace, a few days old.

**Ground rule first.** None of the items below ship until the approved fix list (T-0045..T-0051) is done and the hosted app has run clean for two weeks with daily phone use. Shiny features on a wobbly base lose developers faster than missing features. Estimates are for one focused session each and assume the current zero-dependency Node + Python stack.

## Ranked

| # | Item | Pitch (one line) | Effort | Depends on |
|---|------|------------------|--------|------------|
| 1 | **Bring-your-own-LLM connectors** (Ollama, OpenAI-compatible, Gemini, plus Claude) — *first slice shipped 2026-11-06 (T-0055): backends + context commands + tests + docs; the allowlisted tool runner for non-Claude models is the remaining piece* | Point Chamber at the model you already pay for; the agent box is a 200-line script on your own hardware. | M (2-3 sessions): a connector protocol doc, a Python reference connector with pluggable `ask()` backends, the same locked-tool story for non-Claude models (tool access through our own allowlisted command runner, not the model's harness) | T-0051 API docs; T-0046 (SSE, version check) so every connector shares one transport |
| 2 | **Device-code pairing** — *shipped 2026-11-06 (T-0048)* | "Type this 6-digit code on your Pi and it is in the room." No env-file editing, no secret paste. | S-M (1-2 sessions): pairing codes with 10-minute expiry, approval UI under AI agents, connector `--pair` mode | T-0046 |
| 3 | **Agent runs git, you approve diffs from the phone** — *first slice shipped 2026-11-06 (T-0063): diff on the ticket, approve/reject in the app, connector applies on a branch* | Ticket shows the diff; one tap merges or rejects. Approve-from-bed is the demo. | L (3-4 sessions): connector gains a sandboxed write mode on a branch, server stores diffs on tickets, review UI shows them, merge happens on the agent's machine after approval, full audit | T-0047 structured proposals; T-0050 diff rendering; T-0049 threads for the back-and-forth |
| 4 | **Scheduled and event-triggered agent tasks** — *shipped 2026-11-06 (T-0058)* | "Every morning at 07:00 post the patch posture." Webhooks wake the agent when CI fails or an alert fires. | M (2 sessions): per-workspace schedules and inbound webhook tokens on the server, connector executes with the same guardrails, results posted as messages or tickets | T-0046; T-0047 |
| 5 | **Visible, editable agent memory per room** — *shipped 2026-11-06 (T-0059)* | Developers distrust black boxes; show what the agent remembers and let them prune it. | M (2 sessions): memory as a workspace file the connector reads into its prompt, UI to view and edit, audit of edits | T-0047 (agents write memory through a structured route) |
| 6 | **Multi-agent rooms with hand-offs** — *shipped 2026-11-06 (T-0060)* | Our own two agents already coordinate; make it a product: agents delegate to each other while the human watches, with hop caps. | M (2 sessions): peer list in /api/me, reply_to threads as the hand-off channel, hop counter, commander-started threads only (T-0041 lesson) | T-0049 threads; T-0045 presence |
| 7 | **Compliance audit log and export** — *shipped 2026-11-06 (T-0057)* | Every tool call, every approval, who and when, exportable. Compliance teams buy on this alone. | S-M (1-2 sessions): extend the existing per-workspace audit (agent actions) to human admin actions, searchable UI, CSV/JSON export, retention setting | nothing hard; builds on T-0015 audit and T-0037 retention |
| 8 | **Slack/Discord bridge** — *outbound mirror shipped 2026-11-06 (T-0062); inbound needs a Slack app, not started* | Mirror a room so teams do not have to switch apps on day one. | M (2 sessions): outbound webhook mirror first (cheap), inbound later; identity mapping, loop protection | T-0047 (structured posting), T-0041 lessons (no loops) |
| 9 | **Self-host one-liner** — *shipped 2026-11-06 (T-0061): Dockerfile, compose, Caddy example, SELF-HOSTING.md, CHAMBER_SELF_HOSTED; license key not started* | Docker image plus a license key; our privacy story demands it. | M (2 sessions): Dockerfile with node:22, volume for /var/lib/chamber, env template, license check against api.ghostporttechnologies.com, docs | T-0051 docs; ops/ scripts already versioned |

## Status 2026-11-06 evening

Every item has a first slice in production. The connector is 3.4.0. What is deliberately still open: the tool runner for Claude-less backends is allowlist-only (no write tools), inbound Slack, a self-host license key, and the second slice of diff approval (agents producing diffs with write tools in a sandboxed worktree instead of writing the patch text).

## Suggested sequence (original)

1. Finish the approved fixes in this order: T-0046, T-0051, T-0045, T-0047, T-0049, T-0050, T-0048 (pairing last so it lands on the streaming transport).
2. Two-week stability run with daily phone use; fix what it shakes out.
3. Item 1 (BYO-LLM) and item 2 (pairing demo) together: that is the sales pitch for other teams.
4. Item 7 (audit/export) next: cheap and it unlocks a second kind of buyer.
5. Items 3 and 4 (diff approval, schedules) once a second workspace is using Chamber daily.
6. Items 5, 6, 8, 9 as demand shows.

## Not on the list on purpose

- Mobile native apps: the installable web app covers it; revisit only if push reliability on iOS becomes a complaint.
- Voice or video: different product.
- A hosted model of our own: cost and liability without differentiation; BYO-LLM is the right shape.
