#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  applyPromptAgentDefaults,
  ensureRuntimeArtifacts,
  getCmuxCallerContext,
  getWorkspaceStatePath,
  installCmuxRenderRefreshHooksBestEffort,
  pathExists,
  readSurfaceShimState,
  refreshCmuxSurfacesBestEffort,
  requireCommand,
  writeSurfaceShimState,
} from "../src/shared.js";
import { runWorktreeCommand } from "../src/worktree.js";

function getHelpText(): string {
  return [
    "opencmux",
    "",
    "Usage:",
    "  opencmux [opencode args]",
    "  opencmux open <path> [opencode args]",
    "  opencmux open --cwd <path> [opencode args]",
    "  opencmux new <branch> [--cwd <repo>] [opencode args]",
    "",
    "Examples:",
    '  opencmux --prompt "Continue here"',
    '  opencmux open ~/Desktop/some-worktree --prompt "Continue the work"',
    '  opencmux new my-branch --cwd ~/Desktop/opencmux --prompt "Plan the work"',
    "",
    "Notes:",
    "  - Bare `opencmux` assumes you are already inside cmux.",
    "  - `open` and `new` create or select cmux workspaces for worktrees.",
    "  - When `--prompt` is provided and `--agent` is not, opencmux defaults to `--agent orchestrator`.",
  ].join("\n");
}

function isHelpCommand({ argv }: { argv: string[] }): boolean {
  return (
    argv.length > 0 && argv.some((arg) => arg === "--help" || arg === "-h")
  );
}

function getSimplifiedWorktreeArgs({
  argv,
}: {
  argv: string[];
}): string[] | null {
  const command = argv[0] ?? "";

  if (command === "open") {
    const args = argv.slice(1);
    const firstArg = args[0] ?? "";

    if (!firstArg) {
      throw new Error("Missing worktree path for `opencmux open <path>`");
    }

    if (firstArg === "--cwd") {
      const targetPath = args[1] ?? "";

      if (!targetPath) {
        throw new Error("Missing value for `opencmux open --cwd <path>`");
      }

      return ["--cwd", path.resolve(targetPath), ...args.slice(2)];
    }

    if (firstArg.startsWith("--cwd=")) {
      const targetPath = firstArg.slice("--cwd=".length);

      if (!targetPath) {
        throw new Error("Missing value for `opencmux open --cwd <path>`");
      }

      return ["--cwd", path.resolve(targetPath), ...args.slice(1)];
    }

    if (firstArg.startsWith("-")) {
      throw new Error("Missing worktree path for `opencmux open <path>`");
    }

    return ["--cwd", path.resolve(firstArg), ...args.slice(1)];
  }

  if (command === "new") {
    const branchName = argv[1] ?? "";

    if (!branchName || branchName.startsWith("-")) {
      throw new Error("Missing branch name for `opencmux new <branch>`");
    }

    return ["--create", branchName, ...argv.slice(2)];
  }

  return null;
}

function parseLauncherArgs(argv: string[]): {
  forwardedArgs: string[];
  worktreePath: string | null;
} {
  const forwardedArgs: string[] = [];
  let worktreePath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--opencmux-worktree-path-b64") {
      const encodedValue = argv[index + 1] ?? "";
      if (!encodedValue) {
        throw new Error("Missing value for --opencmux-worktree-path-b64");
      }
      worktreePath = Buffer.from(encodedValue, "base64").toString("utf8");
      index += 1;
      continue;
    }

    forwardedArgs.push(argument);
  }

  return {
    forwardedArgs,
    worktreePath,
  };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (isHelpCommand({ argv: rawArgs })) {
    console.log(getHelpText());
    return;
  }

  const simplifiedWorktreeArgs = getSimplifiedWorktreeArgs({ argv: rawArgs });

  if (simplifiedWorktreeArgs) {
    await runWorktreeCommand({ argv: simplifiedWorktreeArgs });
    return;
  }

  const {
    forwardedArgs,
    worktreePath: launcherWorktreePath,
  } = parseLauncherArgs(rawArgs);
  const resolvedForwardedArgs = applyPromptAgentDefaults({
    args: forwardedArgs,
  });

  const workspaceId = process.env.CMUX_WORKSPACE_ID ?? "";

  if (!workspaceId) {
    throw new Error(
      "opencmux assumes you're already inside cmux. Run bare `opencmux` from a cmux workspace, or use `opencmux open /path/to/worktree` / `opencmux new <branch>` to create or open a worktree workspace.",
    );
  }

  const runtimePaths = await ensureRuntimeArtifacts();
  const cmuxPath = requireCommand("cmux");
  const opencodePath = requireCommand("opencode");
  const callerContext = getCmuxCallerContext();
  installCmuxRenderRefreshHooksBestEffort();
  const sessionKey = randomUUID();
  const statePath = getWorkspaceStatePath({
    workspaceRef: callerContext.workspaceRef,
  });
  const mainPaneId = `%opencmux-main-${sessionKey}`;
  const worktreePath = launcherWorktreePath ?? process.cwd();

  if (await pathExists(statePath)) {
    try {
      const existingState = await readSurfaceShimState({ statePath });
      if (existingState.viewer.servicePid) {
        try {
          process.kill(existingState.viewer.servicePid, "SIGTERM");
        } catch {
          // Ignore stale pids.
        }
      }
    } catch {
      // Ignore corrupt state; it will be recreated below.
    }
  }

  await writeSurfaceShimState({
    statePath,
    state: {
      version: 2,
      workspaceRef: callerContext.workspaceRef,
      worktreePath,
      opencodePaneRef: callerContext.paneRef,
      viewerPaneRef: null,
      viewerSurfaceRef: null,
      mainSurfaceRef: callerContext.surfaceRef,
      mainPaneId,
      virtualSurfacesByPaneId: {
        [mainPaneId]: {
          surfaceRef: callerContext.surfaceRef,
        },
      },
      viewer: {
        enabled: false,
        siteDir: null,
        siteIndexPath: null,
        servicePid: null,
        controlPort: null,
        status: "disabled",
        lastUpdatedAt: null,
        lastError: null,
      },
    },
  });

  const child = spawn(opencodePath, resolvedForwardedArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: runtimePaths.runtimeConfigDir,
      PATH: `${runtimePaths.runtimeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      OPENCMUX_HIDE_TMUX_CHILD_SURFACES: "1",
      TMUX: process.env.TMUX ?? `opencmux:${callerContext.workspaceRef}`,
      TMUX_PANE: mainPaneId,
      OPENCMUX_CMUX_BIN: cmuxPath,
      OPENCMUX_WORKSPACE_ID: workspaceId,
      OPENCMUX_WORKSPACE_REF: callerContext.workspaceRef,
      OPENCMUX_PANE_REF: callerContext.paneRef,
      OPENCMUX_SURFACE_REF: callerContext.surfaceRef,
      OPENCMUX_TAB_ID: callerContext.tabRef,
      OPENCMUX_STATE_PATH: statePath,
    },
  });

  refreshCmuxSurfacesBestEffort({ workspaceRef: callerContext.workspaceRef });

  child.on("exit", (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
