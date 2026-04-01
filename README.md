# codex-router

`codex-router` is a macOS-first wrapper around the stock `codex` CLI. It lets you keep multiple tagged Codex accounts with separate quotas while reusing one shared local Codex context: sessions, MCP setup, prompts, and other non-auth state.

## What it does

- stores multiple tagged accounts such as `codex-1` and `codex-2`
- switches the active account used by the router-managed `codex` wrapper
- keeps your original `~/.codex` untouched
- refreshes live 5-hour and weekly limit percentages per account
- provides a CLI for account routing

## Install dependencies

```bash
npm install
```

## Setup

Run `codex-router init` once to install the optional `codex` shim under `~/.codex-router/bin/codex`.

```bash
codex-router init
```

Then add the printed path export to your shell profile so `~/.codex-router/bin` comes before the real Codex binary on `PATH`. This keeps `~/.codex` unchanged while still letting plain `codex` use the selected router account.

## CLI commands

```bash
codex-router login -t codex-1
codex-router login -t codex-2

codex-router switch codex-2
codex-router current

codex-router status
codex-router status -t codex-1

codex-router del -t codex-1
```

## Example: 2 accounts, 1 shared context

You can switch which account pays for usage without losing the local conversation context managed by the router:

```bash
# Start with account 1.
codex-router switch codex-1
codex

# Example conversation:
# User: I want to tell you a secret.
# User: Today is Wednesday.

# Switch to account 2, then reopen the same session.
codex-router switch codex-2
codex resume <session-id>

# Continue from the same shared context:
# User: what was the secret I told u?
# Assistant: You didn't actually tell me a secret. You said: "Today is Wednesday."
```

The active account changes the auth and quota slot, but the shared router context still carries the session history, prompts, MCP setup, and other non-auth state.

## Managed layout

`codex-router` keeps its own state under `~/.codex-router`:

- `accounts/<tag>/auth.json` - per-account auth slot
- `shared/` - sessions, history, MCP config, prompts, and other shared context
- `runtime/current-home/` - assembled `CODEX_HOME` used by the wrapper-managed `codex`
- `bin/codex` - optional wrapper installed by `codex-router init`
- `state/accounts.json` - tag registry and last observed status snapshots
- `state/wrapper.json` - stored path to the real Codex binary

## `~/.codex` is never written to

`codex-router` never creates, modifies, or deletes `~/.codex`. All router state lives under `~/.codex-router`. It may read from `~/.codex` during the first auto-seed on tagged login and later shared `config.toml` refreshes, but it does not write back to `~/.codex`.

## Notes

- live limit refresh is best-effort and currently reads Codex account/rate-limit state, then normalizes the 5-hour and weekly percentages
- if live percentages cannot be extracted, the tool reports `unknown` instead of guessing
- the active account decides which quota wrapper-managed `codex` uses, while the shared state preserves your local working context
