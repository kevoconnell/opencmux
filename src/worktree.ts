import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  createTerminalSurfaceForPane,
  createWorkspaceForCommand,
  getDefaultWorkspaceName,
  getProjectRoot,
  getRuntimePaths,
  openWorkspaceForCwd,
  parseWorkspaceTree,
  pathExists,
  registerWorktreeWorkspace,
  renameSurfaceTab,
  runCommand,
  selectSurfaceInPane,
  sendKeyToSurface,
  sendToSurface,
  shellQuote,
} from "./shared.js";

type TWorktreeArgs = {
  createBranchName: string | null;
  baseRef: string;
  cwd: string;
  workspaceName: string | null;
  forwardedArgs: string[];
};

function getDefaultBaseRef({ repoCwd }: { repoCwd: string }): string {
  try {
    const currentBranch = runCommand({
      command: "git",
      args: ["-C", repoCwd, "branch", "--show-current"],
    }).trim();

    return currentBranch || "origin/main";
  } catch {
    return "origin/main";
  }
}

function parseArgs(argv: string[]): TWorktreeArgs {
  let createBranchName: string | null = null;
  let cwd = process.cwd();
  let workspaceName: string | null = null;
  let baseRef: string | null = null;
  const forwardedArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--create") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --create");
      }
      createBranchName = value;
      index += 1;
      continue;
    }

    if (argument === "--base") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --base");
      }
      baseRef = value;
      index += 1;
      continue;
    }

    if (argument === "--cwd") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --cwd");
      }
      cwd = path.resolve(value);
      index += 1;
      continue;
    }

    if (argument.startsWith("--cwd=")) {
      const value = argument.slice("--cwd=".length);
      if (!value) {
        throw new Error("Missing value for --cwd");
      }
      cwd = path.resolve(value);
      continue;
    }

    if (argument === "--name") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --name");
      }
      workspaceName = value;
      index += 1;
      continue;
    }

    if (argument === "--no-install") {
      continue;
    }

    if (argument === "--no-doppler") {
      continue;
    }

    forwardedArgs.push(argument);
  }

  return {
    createBranchName,
    baseRef: baseRef ?? getDefaultBaseRef({ repoCwd: cwd }),
    cwd,
    workspaceName,
    forwardedArgs,
  };
}

function ensureGitRefExists({
  repoCwd,
  baseRef,
}: {
  repoCwd: string;
  baseRef: string;
}): boolean {
  try {
    runCommand({
      command: "git",
      args: ["-C", repoCwd, "rev-parse", "--verify", "--quiet", baseRef],
    });
    return true;
  } catch {
    if (baseRef.startsWith("origin/")) {
      try {
        runCommand({
          command: "git",
          args: [
            "-C",
            repoCwd,
            "fetch",
            "origin",
            baseRef.replace(/^origin\//, ""),
          ],
        });
      } catch {
        return false;
      }
    }
  }

  try {
    runCommand({
      command: "git",
      args: ["-C", repoCwd, "rev-parse", "--verify", "--quiet", baseRef],
    });
    return true;
  } catch {
    return false;
  }
}

function repoHasCommits({ repoCwd }: { repoCwd: string }): boolean {
  try {
    runCommand({
      command: "git",
      args: ["-C", repoCwd, "rev-parse", "--verify", "--quiet", "HEAD"],
    });
    return true;
  } catch {
    return false;
  }
}

function findCreatedWorktreePath({
  sourceCwd,
  branchName,
}: {
  sourceCwd: string;
  branchName: string;
}): string | null {
  const worktreeListOutput = runCommand({
    command: "git",
    args: ["-C", sourceCwd, "worktree", "list", "--porcelain"],
  });
  let currentWorktreePath: string | null = null;

  for (const outputLine of worktreeListOutput.split("\n")) {
    const line = outputLine.trim();
    if (!line) {
      currentWorktreePath = null;
      continue;
    }

    if (line.startsWith("worktree ")) {
      currentWorktreePath = line.slice("worktree ".length);
      continue;
    }

    if (currentWorktreePath && line === `branch refs/heads/${branchName}`) {
      return currentWorktreePath;
    }
  }

  return null;
}

async function waitForCreatedWorktreePath({
  sourceCwd,
  branchName,
  doneFilePath,
}: {
  sourceCwd: string;
  branchName: string;
  doneFilePath: string;
}): Promise<string | null> {
  for (;;) {
    try {
      const worktreePath = findCreatedWorktreePath({
        sourceCwd,
        branchName,
      });
      if (worktreePath) {
        return worktreePath;
      }
    } catch {
      // Keep polling while wt is still creating the worktree.
    }

    if (await pathExists(doneFilePath)) {
      return null;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function runWorktreeCommand({
  argv,
}: {
  argv: string[];
}): Promise<void> {
  const { createBranchName, baseRef, cwd, workspaceName, forwardedArgs } =
    parseArgs(argv);

  if (!createBranchName) {
    const resolvedWorkspaceName =
      workspaceName ?? getDefaultWorkspaceName({ cwd });
    const { output: createOutput } = await openWorkspaceForCwd({
      cwd,
      workspaceName: resolvedWorkspaceName,
      forwardedArgs,
    });
    console.log(createOutput);
    return;
  }

  const hasCommits = repoHasCommits({ repoCwd: cwd });
  const hasResolvedBaseRef = ensureGitRefExists({
    repoCwd: cwd,
    baseRef,
  });

  if (!hasResolvedBaseRef && hasCommits) {
    throw new Error(`Could not resolve base ref: ${baseRef}`);
  }

  const runtimePaths = getRuntimePaths();
  await fs.mkdir(runtimePaths.runtimeStateDir, { recursive: true });

  const fileSuffix = randomUUID();
  const pathFilePath = path.join(
    runtimePaths.runtimeStateDir,
    `worktree-path-${fileSuffix}.txt`,
  );
  const doneFilePath = path.join(
    runtimePaths.runtimeStateDir,
    `worktree-done-${fileSuffix}.txt`,
  );

  const wtCommandParts = [
    "wt",
    "-C",
    cwd,
    "switch",
    "--create",
    createBranchName,
  ];
  if (hasResolvedBaseRef) {
    wtCommandParts.push("--base", baseRef);
  }
  wtCommandParts.push(
    "--yes",
    "-x",
    `bash -lc ${shellQuote(`pwd > ${shellQuote(pathFilePath)}`)}`,
  );

  const createScript = [
    `rm -f ${shellQuote(pathFilePath)} ${shellQuote(doneFilePath)}`,
    wtCommandParts.map(shellQuote).join(" "),
    "wt_exit_code=$?",
    `printf "%s" "$wt_exit_code" > ${shellQuote(doneFilePath)}`,
    'echo "[opencmux] wt exited with code $wt_exit_code"',
    `exec ${shellQuote(process.env.SHELL ?? "/bin/bash")} -l`,
  ].join("; ");

  const resolvedWorkspaceName =
    workspaceName ?? `OpenCode | ${createBranchName}`;
  const { output: createOutput, workspaceRef } =
    await createWorkspaceForCommand({
      cwd,
      workspaceName: resolvedWorkspaceName,
      commandString: `bash -lc ${shellQuote(createScript)}`,
    });

  const primaryPane = parseWorkspaceTree({ workspaceRef }).panes[0] ?? null;
  const primaryPaneRef = primaryPane?.paneRef ?? null;
  if (!primaryPaneRef) {
    throw new Error(`Failed to resolve primary pane for ${workspaceRef}`);
  }

  const { surfaceRef: opencodeSurfaceRef } = createTerminalSurfaceForPane({
    workspaceRef,
    paneRef: primaryPaneRef,
  });
  renameSurfaceTab({
    workspaceRef,
    surfaceRef: opencodeSurfaceRef,
    title: "OpenCode",
  });

  const projectRoot = getProjectRoot();
  const tsxPath = path.join(projectRoot, "node_modules", ".bin", "tsx");
  const launcherPath = path.join(projectRoot, "src", "commands", "opencmux.ts");
  const launcherArgs = [
    tsxPath,
    launcherPath,
    "--opencmux-worktree-path-b64",
    '"$worktree_path_b64"',
    ...forwardedArgs,
  ]
    .map((commandPart) =>
      commandPart === '"$worktree_path_b64"'
        ? commandPart
        : shellQuote(commandPart),
    )
    .join(" ");
  const opencodeCommand = [
    `branch_name=${shellQuote(createBranchName)}`,
    `while true; do worktree_path=$(git -C ${shellQuote(cwd)} worktree list --porcelain | awk -v target_ref="refs/heads/$branch_name" '/^worktree /{worktree=$2} /^branch /{if ($2 == target_ref) {print worktree; exit}}'); if [ -n "$worktree_path" ]; then break; fi; if [ -f ${shellQuote(doneFilePath)} ]; then echo "[opencmux] wt create did not produce a worktree path"; exec ${shellQuote(process.env.SHELL ?? "/bin/bash")} -l; fi; sleep 1; done`,
    'worktree_path_b64=$(printf "%s" "$worktree_path" | base64 | tr -d \'[:space:]\')',
    'cd "$worktree_path"',
    `exec env ${launcherArgs}`,
  ].join("; ");

  sendToSurface({
    workspaceRef,
    surfaceRef: opencodeSurfaceRef,
    text: `bash -lc ${shellQuote(opencodeCommand)}`,
  });
  sendKeyToSurface({
    workspaceRef,
    surfaceRef: opencodeSurfaceRef,
    key: "enter",
  });
  selectSurfaceInPane({
    workspaceRef,
    paneRef: primaryPaneRef,
    surfaceRef: opencodeSurfaceRef,
  });

  const worktreeCwd = await waitForCreatedWorktreePath({
    sourceCwd: cwd,
    branchName: createBranchName,
    doneFilePath,
  });
  if (worktreeCwd) {
    await registerWorktreeWorkspace({
      worktreePath: worktreeCwd,
      workspaceRef,
    });
  }

  console.log(`branch: ${createBranchName}`);
  if (hasResolvedBaseRef) {
    console.log(`base: ${baseRef}`);
  } else {
    console.log("base: (none; created from unborn repo)");
  }
  if (worktreeCwd) {
    console.log(`path: ${worktreeCwd}`);
  }
  console.log(createOutput);
}
