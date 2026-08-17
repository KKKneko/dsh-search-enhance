# Cache-safe progressive disclosure development rules

This file is a task handoff contract for the cache-preserving progressive-disclosure refactor. It supplements `AGENTS.md`; the repository's existing public-extension and write-boundary rules remain authoritative.

## Root cause and invariant

DeepSeek Context Caching is automatic prefix caching. Under the current DSH loop, rendered system text, visible tool schemas, and prior session messages are sent on every step. Any change to model-visible system text, visible tool set, schema, or order can invalidate reuse from the first changed token. Tool results and other append-only history are safe: they follow the reusable prefix.

The refactor must make these values byte-stable for the lifetime of an Agent, including after every disclosure transition:

- rendered Search Enhance system prompt text;
- Native visible tool schema set and order;
- Code Mode `tools:sdk` text and top-level `run_code` schema.

The provider remains best-effort; this invariant removes plugin-induced prefix churn but cannot promise a provider hit on every request.

## Required architecture

Keep progressive disclosure, but stop changing `ctx.tools` visibility after startup. The permanent model-facing surface is:

- `web_search`
- `docs_search`
- `web_extract`
- `search_tools` — returns an append-only capability/operation manifest;
- `search_call` — a fixed generic dispatcher for an operation already disclosed.

Deferred operation schemas and descriptions must be returned in the `search_tools` result, not inserted into `systemPrompt` or the `tools` array. `search_call` validates the requested operation against the persisted/folded active capability state, validates its arguments and canonical result, forwards `exec.signal`, and preserves the operation's model rendering. A call before disclosure must fail closed.

`web_search`/`docs_search` source auto-disclosure must remain append-only: the result may explain the newly available `search_sources` operation, while the next request still uses the fixed surface. Existing Session-event folding/recovery should remain the source of truth; do not introduce a parallel mutable disclosure state.

Remove state-dependent system-prompt prose (remaining group lists and visibility-dependent variants). Keep only deterministic static guidance. Do not use `agent.inject()` as a cache workaround when the existing tool result already carries the fact.

Do not retain a second direct model-facing path for deferred operations. Internal operation definitions may share schemas, execution, output rendering, and bounds, but Native and Code Mode must use the same fixed `search_call` schema, execution policy, and canonical JSON result.

## DSH constraints

Use only public DSH/Cordis seams. Do not edit DSH installation files or `references/dsh-plugin-development/**`. Do not filter only the prompt assembly while leaving lookup/execution inconsistent. Do not bypass cancellation, output validation, or lifecycle disposal. Model-visible facts must be reconstructable from standard session events/results. Preserve HMR/dispose cleanup.

## Worktree boundary

At handoff time there are unrelated, pre-existing uncommitted anti-bot/Cloudflare changes in `README.md`, several `src/providers/*` files, and provider tests. Do not modify, reset, stage, or commit those paths. Never use destructive Git commands. Each task must stage only its own cache-refactor paths and make one atomic commit; leave unrelated worktree changes intact.

## Validation contract

Add focused tests for stable system/tool/Code SDK hashes across initial, source-auto-disclosure, explicit capability disclosure, recovery, and rejected inactive calls. Test Native and Code Mode through the real DSH assembly/loader seams where available. Run relevant tests, `git diff --check`, and the protected upstream SHA-256 check before handoff. Report any live-provider cache behavior as unverified unless raw DeepSeek usage was captured.
