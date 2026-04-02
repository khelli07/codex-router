# codex-router

> Beta: `codex-router` is still under active development.
>
> It works today, but the behavior is still being refined, especially around mirroring, edge cases, and overall UX. Expect rough edges, test carefully before depending on it, and keep a backup of `~/.codex` if you are experimenting with it.

`codex-router` is a macOS-first wrapper around the stock `codex` CLI. It lets you keep multiple tagged Codex accounts with separate quotas while sharing one local Codex state across them.

In practice, it gives you:

- multiple tagged accounts such as `codex-1`, `codex-2`
- a simple `switch` command to choose which account pays for usage
- a shared non-auth Codex environment across those accounts
- per-account status reporting with 5-hour and weekly remaining quota

## What Problem It Solves

If you use more than one Codex account, the stock CLI does not give you a simple way to swap accounts while keeping one local setup.

`codex-router` separates two concerns:

- auth is stored per tagged account
- non-auth local state is shared

That means you can switch accounts without manually rebuilding your local setup every time.

## High-Level Model

`codex-router` treats local Codex state in two buckets:

- auth state: stored per tag under `~/.codex-router/accounts/<tag>/auth.json`
- non-auth state: mirrored with `~/.codex`

Current flow:

1. `codex-router login -t <tag>` logs in one tagged account.
2. `codex-router switch <tag>` marks that tag as active.
3. routed `codex` launches use that active tag's auth.
4. non-auth state is mirrored between `~/.codex` and `~/.codex-router`.

The intended result is:

- account identity and quota come from the selected tag
- config, skills, MCP setup, sessions, and other non-auth state remain shared

## Current Status Behavior

`codex-router status` shows:

- how much **5-hour quota is left**
- how much **weekly quota is left**
- the 5-hour reset window
- the weekly reset window
- which tag is active
- the account email when available
- whether the account is ready or needs login

## Install

### Install from source

Clone the repo, install dependencies, and build:

```bash
git clone <repo-url>
cd codex-router
npm install
npm run build
```

If you want the local repo version available as `codex-router` in your shell:

```bash
npm link
hash -r
```

You can also run the built CLI directly without linking:

```bash
node dist/src/cli/index.js --help
```

## Setup

Run this once to install the optional routed `codex` shim:

```bash
codex-router init
```

That installs:

```text
~/.codex-router/bin/codex
```

Then add the printed path export to your shell profile so `~/.codex-router/bin` comes before the real Codex binary on `PATH`.

After that:

- `codex-router` manages account tags and status
- routed `codex` launches use the selected tag

## Command Reference

### Log in a tagged account

```bash
codex-router login -t codex-1
codex-router login -t codex-2
```

### Switch the active account

```bash
codex-router switch codex-1
codex-router switch codex-2
```

### Show current active tag

```bash
codex-router current
```

### Show status for all tags

```bash
codex-router status
```

### Show status for one tag

```bash
codex-router status -t codex-1
```

### Delete a tag

```bash
codex-router del -t codex-1
```

Note:

- you cannot delete the currently active tag
- deleting a tag removes that tag's auth slot from `~/.codex-router/accounts/<tag>`

## Example Workflow

This is the simplest way to explain and test how it works.

### 1. Log in two accounts

```bash
codex-router login -t codex-1
codex-router login -t codex-2
```

### 2. Use account 1

```bash
codex-router switch codex-1
codex
```

Inside Codex:

- run `/status`
- confirm the account shown matches the `codex-1` email
- optionally change model using `/model`
- optionally note the session id
- exit Codex

### 3. Switch to account 2

```bash
codex-router switch codex-2
codex
```

Inside Codex:

- run `/status`
- confirm the account shown now matches the `codex-2` email
- verify your non-auth state is still there

Examples of non-auth state you may want to verify:

- model/config
- skills
- MCP setup
- sessions

If you want to prove session continuity explicitly:

```bash
codex resume <session-id>
```

What this demonstrates:

- the billing/quota account changes when you `switch`
- local non-auth state is shared rather than isolated per account

## Example Status Output

`codex-router status` looks like this conceptually:

```text
ACTIVE  TAG         5H_LEFT   WEEKLY_LEFT  5H_RESET    WEEKLY_RESET  ACCOUNT                 AUTH
*       codex-1     98%       69%          4h 11m      6d 4h         first@example.com       ready
        codex-2     100%      99%          5h          6d 5h         second@example.com      ready
```

Single-tag detail:

```text
tag: codex-1
active: yes
five_hour_left_pct: 98%
weekly_left_pct: 69%
five_hour_reset_in: 4h 11m
weekly_reset_in: 6d 4h
raw_limit_source: app-server account/rateLimits/read
account: first@example.com
auth_state: ready
auth_storage_path: /Users/you/.codex-router/accounts/codex-1/auth.json
last_switch_at: 2026-04-02T...
last_status_check_at: 2026-04-02T...
```

When run in an interactive terminal, the table is themed with colors. When piped or when `NO_COLOR` is set, it falls back to plain text.

## Mirroring Behavior

`codex-router` currently mirrors non-auth state between `~/.codex` and `~/.codex-router`.

Current intended behavior:

- tagged login refreshes router shared state from `~/.codex`
- routed `codex` launch refreshes router shared state from `~/.codex`
- after routed `codex` exits, runtime non-auth state is synced back into `~/.codex`

This is meant to keep account auth separate while keeping the local Codex environment shared.

## Managed Layout

`codex-router` keeps its own state under:

```text
~/.codex-router
```

Important paths:

- `accounts/<tag>/auth.json` — per-account auth slot
- `shared/` — mirrored non-auth shared state
- `runtime/current-home/` — assembled runtime `CODEX_HOME` used by routed `codex`
- `bin/codex` — optional wrapper installed by `codex-router init`
- `state/accounts.json` — tag registry and last observed status snapshots
- `state/wrapper.json` — stored path to the real Codex binary

## Backup and Reset

Before testing beta behavior, backing up `~/.codex` is recommended:

```bash
rsync -a ~/.codex/ ~/.codex.backup/
```

If you want a clean router reset:

```bash
rm -rf ~/.codex-router
```

That removes router-managed tags and runtime state, but it does **not** delete `~/.codex`.

After deleting `~/.codex-router`, you will need to:

- log in your tagged accounts again
- run `codex-router init` again if you also want to recreate the wrapper setup

## Testing Checklist

If you want to test the current behavior end-to-end:

### Status

- `codex-router status` shows `5H_LEFT` and `WEEKLY_LEFT`
- `codex-router status` shows both reset windows
- colors appear in a real terminal
- output is plain when piped

Examples:

```bash
codex-router status
codex-router status | cat
codex-router status -t codex-1
```

### Account switching

- `switch codex-1` then `codex` shows account 1 in `/status`
- `switch codex-2` then `codex` shows account 2 in `/status`

### Mirroring

- change model/config in routed `codex`
- exit Codex
- confirm `~/.codex/config.toml` reflects the change
- relaunch routed `codex` and verify the model did not reset

### Skills / MCP / other local setup

- add or change something in `~/.codex`
- run routed `codex`
- verify it is visible under router shared/runtime state

## Troubleshooting

### `zsh: permission denied: codex-router`

This usually means your linked executable is missing the execute bit or your shell resolved the wrong path.

Useful checks:

```bash
type -a codex-router
ls -l "$(command -v codex-router)"
hash -r
```

Rebuild and relink:

```bash
npm run build
npm link
hash -r
```

### `codex-router` command not found

Run directly from the repo:

```bash
node dist/src/cli/index.js status
```

Or link it:

```bash
npm link
```

### Wrapper `codex` not being used

Make sure `~/.codex-router/bin` comes before the real Codex binary on `PATH`.

Check:

```bash
which codex
```

### Status shows `unknown`

This means live limit data could not be extracted from the current Codex CLI/account state. The tool falls back to `unknown` instead of guessing.

## Development

Build:

```bash
npm run build
```

Typecheck:

```bash
npm run check
```

Test:

```bash
npm test
```

Dry-run package:

```bash
npm pack --dry-run
```

## Current Caveats

This project is still beta. In particular:

- mirroring semantics are still being refined
- edge cases around deletion/sync behavior may still need work
- account-reuse and status metadata flows may still need more hardening
- UX and output formatting are still evolving

If you are testing it, treat it as an experimental power-user tool rather than a polished stable release.
