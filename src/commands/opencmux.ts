#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { forwardChildExit, runCli } from "../cli.js";
import {
  applyPromptAgentDefaults,
  ensureRuntimeArtifacts,
  getCmuxCallerContext,
  getConfiguredOpencmuxConfig,
  getWorkspaceStatePath,
  installCmuxRenderRefreshHooksBestEffort,
  pathExists,
  readSurfaceShimState,
  refreshCmuxSurfacesBestEffort,
  requireCommand,
  setConfiguredDefaultPromptSkills,
  writeSurfaceShimState,
} from "../shared.js";
import { runWorktreeCommand } from "../worktree.js";

function getHelpText(): string {
  return [
    "opencmux",
    "",
    "Usage:",
    "  opencmux [opencode args]",
    "  opencmux skills [list]",
    "  opencmux skills set <skill...>",
    "  opencmux skills add <skill...>",
    "  opencmux skills remove <skill...>",
    "  opencmux skills clear",
    "  opencmux open <path> [opencode args]",
    "  opencmux open --cwd <path> [opencode args]",
    "  opencmux new <branch> [--cwd <repo>] [opencode args]",
    "",
    "Examples:",
    '  opencmux --prompt "Continue here"',
    "  opencmux skills list",
    "  opencmux skills set planner cloudflare",
    '  opencmux open ~/Desktop/some-worktree --prompt "Continue the work"',
    '  opencmux new my-branch --cwd ~/Desktop/opencmux --prompt "Plan the work"',
    "",
    "Notes:",
    "  - Bare `opencmux` assumes you are already inside cmux.",
    "  - `open` and `new` create or select cmux workspaces for worktrees.",
    "  - When `--prompt` is provided and `--agent` is not, opencmux defaults to `--agent orchestrator`.",
    "  - `opencmux skills ...` manages the default skills appended to `--prompt`.",
  ].join("\n");
}

function getSkillsHelpText(): string {
  return [
    "opencmux skills",
    "",
    "Usage:",
    "  opencmux skills [list]",
    "  opencmux skills set <skill...>",
    "  opencmux skills add <skill...>",
    "  opencmux skills remove <skill...>",
    "  opencmux skills clear",
    "",
    "Examples:",
    "  opencmux skills list",
    "  opencmux skills set planner cloudflare",
    "  opencmux skills add web-perf wrangler",
    "  opencmux skills remove planner",
    "  opencmux skills clear",
  ].join("\n");
}

function normalizeSkillArgs(skillNames: string[]): string[] {
  return [...new Set(skillNames.map((value) => value.trim()).filter(Boolean))];
}

async function handleSkillsCommand({
  argv,
}: {
  argv: string[];
}): Promise<void> {
  const subcommand = argv[1] ?? "list";
  const configuredSkillNames =
    getConfiguredOpencmuxConfig().defaultPromptSkills ?? [];

  if (subcommand === "--help" || subcommand === "-h") {
    console.log(getSkillsHelpText());
    return;
  }

  if (subcommand === "list") {
    if (argv.length > 2) {
      throw new Error("`opencmux skills list` does not accept extra arguments");
    }

    if (configuredSkillNames.length === 0) {
      console.log("No default prompt skills configured.");
      return;
    }

    console.log(configuredSkillNames.join("\n"));
    return;
  }

  if (subcommand === "clear") {
    if (argv.length > 2) {
      throw new Error(
        "`opencmux skills clear` does not accept extra arguments",
      );
    }

    await setConfiguredDefaultPromptSkills({ skillNames: [] });
    console.log("Cleared default prompt skills.");
    return;
  }

  const requestedSkillNames = normalizeSkillArgs(argv.slice(2));
  if (requestedSkillNames.length === 0) {
    throw new Error(`Missing skills for \`opencmux skills ${subcommand}\``);
  }

  if (subcommand === "set") {
    const savedSkillNames = await setConfiguredDefaultPromptSkills({
      skillNames: requestedSkillNames,
    });
    console.log(savedSkillNames.join("\n"));
    return;
  }

  if (subcommand === "add") {
    const savedSkillNames = await setConfiguredDefaultPromptSkills({
      skillNames: [...configuredSkillNames, ...requestedSkillNames],
    });
    console.log(savedSkillNames.join("\n"));
    return;
  }

  if (subcommand === "remove") {
    const requestedSkillSet = new Set(requestedSkillNames);
    const savedSkillNames = await setConfiguredDefaultPromptSkills({
      skillNames: configuredSkillNames.filter(
        (skillName) => !requestedSkillSet.has(skillName),
      ),
    });

    if (savedSkillNames.length === 0) {
      console.log("No default prompt skills configured.");
      return;
    }

    console.log(savedSkillNames.join("\n"));
    return;
  }

  throw new Error(`Unsupported skills subcommand: ${subcommand}`);
}

function isHelpCommand({ argv }: { argv: string[] }): boolean {
  const firstArg = argv[0] ?? "";
  return firstArg === "--help" || firstArg === "-h";
}

function getSimplifiedWorktreeArgs({
  argv,
}: {
  argv: string[];
}): string[] | null {
  const command = argv[0] ?? "";

  if (command === "open") {
    const args = argv.slice(1);

    if (args.length === 0) {
      throw new Error("Missing worktree path for `opencmux open <path>`");
    }

    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index] ?? "";

      if (argument === "--cwd") {
        const targetPath = args[index + 1] ?? "";

        if (!targetPath) {
          throw new Error("Missing value for `opencmux open --cwd <path>`");
        }

        return [
          ...args.slice(0, index),
          "--cwd",
          path.resolve(targetPath),
          ...args.slice(index + 2),
        ];
      }

      if (argument.startsWith("--cwd=")) {
        const targetPath = argument.slice("--cwd=".length);

        if (!targetPath) {
          throw new Error("Missing value for `opencmux open --cwd <path>`");
        }

        return [
          ...args.slice(0, index),
          "--cwd",
          path.resolve(targetPath),
          ...args.slice(index + 1),
        ];
      }

      if (argument === "--name") {
        if (!args[index + 1]) {
          throw new Error("Missing value for --name");
        }

        index += 1;
        continue;
      }

      if (argument === "--no-install" || argument === "--no-doppler") {
        continue;
      }

      if (!argument.startsWith("-")) {
        return [
          ...args.slice(0, index),
          "--cwd",
          path.resolve(argument),
          ...args.slice(index + 1),
        ];
      }
    }

    throw new Error("Missing worktree path for `opencmux open <path>`");
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

async function readLaunchPayload({
  payloadPath,
}: {
  payloadPath: string;
}): Promise<{
  forwardedArgs: string[];
  worktreePath: string | null;
}> {
  const payloadContent = await fs.readFile(payloadPath, "utf8");

  try {
    const payload = JSON.parse(payloadContent) as unknown;

    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid workspace launch payload");
    }

    const version = Reflect.get(payload, "version");
    const forwardedArgs = Reflect.get(payload, "forwardedArgs");
    const worktreePath = Reflect.get(payload, "worktreePath");

    if (version !== 1) {
      throw new Error("Unsupported workspace launch payload version");
    }

    if (
      !Array.isArray(forwardedArgs) ||
      forwardedArgs.some((arg) => typeof arg !== "string")
    ) {
      throw new Error("Invalid forwarded args in workspace launch payload");
    }

    if (!(typeof worktreePath === "string" || worktreePath === null)) {
      throw new Error("Invalid worktree path in workspace launch payload");
    }

    return {
      forwardedArgs,
      worktreePath,
    };
  } finally {
    await fs.unlink(payloadPath).catch(() => undefined);
  }
}

async function parseLauncherArgs(argv: string[]): Promise<{
  forwardedArgs: string[];
  worktreePath: string | null;
}> {
  const forwardedArgs: string[] = [];
  let worktreePath: string | null = null;
  let launchPayloadPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--opencmux-launch-payload-path") {
      const payloadPath = argv[index + 1] ?? "";
      if (!payloadPath) {
        throw new Error("Missing value for --opencmux-launch-payload-path");
      }
      launchPayloadPath = payloadPath;
      index += 1;
      continue;
    }

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

  if (launchPayloadPath) {
    return readLaunchPayload({ payloadPath: launchPayloadPath });
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

  if (rawArgs[0] === "skills") {
    await handleSkillsCommand({ argv: rawArgs });
    return;
  }

  const simplifiedWorktreeArgs = getSimplifiedWorktreeArgs({ argv: rawArgs });

  if (simplifiedWorktreeArgs) {
    await runWorktreeCommand({ argv: simplifiedWorktreeArgs });
    return;
  }

  const { forwardedArgs, worktreePath: launcherWorktreePath } =
    await parseLauncherArgs(rawArgs);
  const worktreePath = launcherWorktreePath ?? process.cwd();
  const resolvedForwardedArgs = await applyPromptAgentDefaults({
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
      OPENCMUX_SURFACE_ID: callerContext.surfaceRef,
      OPENCMUX_SURFACE_REF: callerContext.surfaceRef,
      OPENCMUX_TAB_ID: callerContext.tabRef,
      OPENCMUX_STATE_PATH: statePath,
      OPENCMUX_WORKTREE_PATH: worktreePath,
    },
  });

  refreshCmuxSurfacesBestEffort({ workspaceRef: callerContext.workspaceRef });

  forwardChildExit(child);
}

runCli(main);
