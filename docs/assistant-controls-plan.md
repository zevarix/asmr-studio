# Assistant controls implementation plan

## Goal and approach

Implement [optional assistant controls](https://github.com/zevarix/asmr-studio/issues/3)
for one explicitly enabled browser tab. Use the existing loopback API, validated
scene commands, browser mixer, and an MCP adapter over local standard input/output.
The mixer remains usable with no assistant or connection enabled.

Writing only to saved scenes cannot establish what a browser plays. Broadcasting
to every tab would also affect unrelated listening sessions. Instead, each tab
opts in, receives a separate identity and short-lived connection, and reports its
displayed draft and observed player state. A paired assistant must name that
device and connection in each command.

## Boundaries

- Keep Node.js 22.23.3, npm 10.9.9, React, Fastify, and the existing Zod contracts.
- Pin the official MCP server and test client to 2.4.0. Their Apache-2.0 licenses
  remain separate from the application's MIT license.
- Use a distinct browser credential for observations and a device-scoped control
  credential for the assistant. Keep both transient and out of saved sessions.
- Retain strict loopback Host/Origin checks. Add no public endpoint, remote hosting,
  multi-user account system, narration provider, or automatic playback on enrollment.
- Require request identity and expected state version. New local edits, session
  changes, saves, and transport actions invalidate obsolete commands and undo.
- Keep persisted revision, command receipt, and observed playback separate.
  A delivered command with a missing acknowledgement has an unconfirmed outcome.

## Implementation

1. **Contracts and broker.** Add `packages/contracts/src/assistant.ts` and
   `apps/server/src/playback-devices.ts`. Validate registrations, polls, commands,
   acknowledgements, and revocations; retain immutable request receipts within each
   connection. Test wrong credentials, cross-device targeting, payload conflicts,
   expiration, disconnection, stale acknowledgements, and bounded retention.
2. **Browser application.** Add `apps/web/src/features/assistant/` and make the
   existing `App` operations awaitable. Track a synchronous state version in
   `useSession`. Share validated editing and transport behavior between UI and
   assistant. Undo only the latest successful assistant edit while its resulting
   version remains current. Reject unsaved-session replacement unless explicitly
   requested. Test concurrent local edits, failed decoding, reconnect, and revoke.
3. **Audio cancellation.** Add optional request guards to mixer loading, editing,
   and starting. Check after asynchronous preparation before committing a graph
   or starting sources. Verify canceled decoding preserves the previous audible
   mix and a canceled resume cannot start later.
4. **MCP adapter.** Add `apps/mcp/`, using the official stdio transport and the
   existing local API. Provide paired-device discovery, state/library reads,
   command submission/reconciliation, and guarded edit undo. Validate configuration,
   reject redirects, and never automatically repeat an uncertain mutation.
5. **End-to-end acceptance and help.** Use a real stdio client with two browser
   tabs and generated audio. Prove only the selected tab's displayed and audible
   mix changes; cover retries, stale edits, save, undo, and disconnect. Add setup
   instructions and an installable composition skill with generic examples.

## Review focus

Pay particular attention to user edits during decoding, revocation while a resume
is pending, lost acknowledgement responses, delayed observations, and a saved
revision advancing while a newer draft remains unsaved. Existing timer, equalizer,
transition, export, and interrupted-playback behavior must remain intact.

Run affected unit tests, workspace and browser TypeScript checks, a production
build, and the integration/browser suites affected by shared playback changes.
Review the exact final diff and read back the integrated commit. Physical-phone
background behavior and subjective listening remain separate acceptance work.
