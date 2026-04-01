# codex-router

`codex-router` is a macOS-first wrapper around the stock `codex` CLI. It lets you keep multiple tagged Codex accounts with separate quotas while reusing one shared local Codex context: sessions, MCP setup, prompts, and other non-auth state.

## What it does

- stores multiple tagged accounts such as `codex-1` and `codex-2`
- switches the active account without overwriting your shared local context
- assembles a managed runtime `CODEX_HOME` for launches
- refreshes live 5-hour and weekly limit percentages per account
- provides both a CLI and a lightweight local web UI

## Install dependencies

```bash
npm install
```

## CLI commands

```bash
codex-router login -t codex-1
codex-router login -t codex-2

codex-router switch codex-2
codex-router current

codex-router status
codex-router status -t codex-1

codex-router launch
codex-router del -t codex-1
```

## Shared state import

To copy your current local Codex context into the shared router-managed area:

```bash
codex-router import
```

By default this imports from `~/.codex` into `~/.codex-router/shared`.

## GUI

Start the lightweight local web UI:

```bash
npm run gui
```

It serves a small browser-based dashboard on `http://127.0.0.1:4035`.

## Managed layout

`codex-router` keeps its own state under `~/.codex-router`:

- `accounts/<tag>/auth.json` - per-account auth slot
- `shared/` - sessions, history, MCP config, prompts, and other shared context
- `runtime/current-home/` - assembled `CODEX_HOME` used for the next launch
- `state/accounts.json` - tag registry and last observed status snapshots

## Notes

- live limit refresh is best-effort and currently probes Codex directly, then normalizes the 5-hour and weekly percentages
- if live percentages cannot be extracted, the tool reports `unknown` instead of guessing
- the active account decides which quota Codex uses, while the shared state preserves your local working context
