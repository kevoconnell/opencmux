# opencmux

`opencmux` launches OpenCode inside a cmux workspace and adds shortcuts for opening an existing worktree or creating a new one.

## What it does

- runs `opencode` inside the current cmux workspace
- opens a specific worktree in its own workspace
- creates a new git worktree and launches into it
- defaults `--prompt` sessions to `--agent orchestrator` unless you pass `--agent` yourself

## Requirements

- `cmux`
- `opencode`
- Node.js + `pnpm`

## Setup

```bash
cd ~/Desktop/opencmux
pnpm install
```

Make sure the `opencmux` shell wrapper is on your `PATH` if you want to run it globally.

## Usage

```bash
opencmux [opencode args]
opencmux open <path> [opencode args]
opencmux open --cwd <path> [opencode args]
opencmux new <branch> [--cwd <repo>] [opencode args]
```

## Common examples

Run inside the current cmux workspace:

```bash
opencmux --prompt "Review the latest changes"
```

Open an existing worktree path:

```bash
opencmux open ~/Desktop/some-worktree --prompt "Review the latest changes"
```

Create a new worktree from a repo:

```bash
opencmux new my-branch --base origin/main --prompt "Implement the feature"
```

Useful flags for `open` and `new`:

```bash
--cwd <repo-or-worktree>
--name <workspace-name>
--no-install
--no-doppler
```

## How it behaves

- Bare `opencmux` assumes you are already inside cmux.
- `open` treats the target path as the worktree to launch.
- `new` creates a worktree, then opens it in cmux.
- If you pass `--prompt` without `--agent`, `opencmux` adds `--agent orchestrator`.

## Runtime files

`opencmux` creates local runtime artifacts under `runtime/`, including:

- a dedicated OpenCode config directory
- a tmux shim used for cmux compatibility
- workspace state and viewer files

Those files are generated locally and are not the source of truth.

## Source of truth

- `bin/*.ts` and `src/*.ts` are the executable source of truth
- shell wrappers in `bin/` invoke those TypeScript entrypoints through `tsx`
