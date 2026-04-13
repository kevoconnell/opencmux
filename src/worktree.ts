import fs from "node:fs";
import path from "node:path";
import {
  copyEnvFileIfPresent,
  getDefaultWorkspaceName,
  getReploDevEnvFromSource,
  getReploDevNameFromSource,
  openWorkspaceForCwd,
  pathExists,
  runCommand,
  setReploDevEnvInEnv,
  setReploDevNameInEnv,
} from "./shared.js";

type TWorktreeArgs = {
  createBranchName: string | null;
  baseRef: string;
  cwd: string;
  workspaceName: string | null;
  forwardedArgs: string[];
  shouldInstall: boolean;
  shouldConfigureDoppler: boolean;
};

function parseArgs(argv: string[]): TWorktreeArgs {
  let createBranchName: string | null = null;
  let baseRef = "origin/main";
  let cwd = process.cwd();
  let workspaceName: string | null = null;
  let shouldInstall = true;
  let shouldConfigureDoppler = true;
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
      shouldInstall = false;
      continue;
    }

    if (argument === "--no-doppler") {
      shouldConfigureDoppler = false;
      continue;
    }

    forwardedArgs.push(argument);
  }

  return {
    createBranchName,
    baseRef,
    cwd,
    workspaceName,
    forwardedArgs,
    shouldInstall,
    shouldConfigureDoppler,
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

function stripAnsi({ text }: { text: string }): string {
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
}

function isLikelyPnpmProject({ cwd }: { cwd: string }): boolean {
  return (
    fs.existsSync(path.join(cwd, "package.json")) &&
    (fs.existsSync(path.join(cwd, "pnpm-lock.yaml")) ||
      fs.existsSync(path.join(cwd, "pnpm-workspace.yaml")))
  );
}

function parseWorktreePathFromWtOutput({ output }: { output: string }): string {
  const cleanedOutput = stripAnsi({ text: output });
  const outputLines = cleanedOutput
    .split("\n")
    .map((outputLine) => outputLine.trim())
    .filter(Boolean);
  const lastLine = outputLines.at(-1) ?? "";

  if (!lastLine.startsWith("/")) {
    throw new Error(
      `Failed to parse worktree path from wt output:\n${cleanedOutput}`,
    );
  }

  return lastLine;
}

function maybeInstallWorkspaceDependencies({
  cwd,
  shouldInstall,
}: {
  cwd: string;
  shouldInstall: boolean;
}): void {
  if (!shouldInstall || !isLikelyPnpmProject({ cwd })) {
    return;
  }

  try {
    runCommand({ command: "pnpm", args: ["install"], cwd });
  } catch (error) {
    console.warn(
      [
        "warning: `pnpm install` failed; continuing without dependencies.",
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
    );
  }
}

type TGitWorktreeEntry = {
  worktreePath: string;
  branchRef: string | null;
};

function parseGitWorktreeList({
  output,
}: {
  output: string;
}): TGitWorktreeEntry[] {
  const entries: TGitWorktreeEntry[] = [];
  let currentEntry: TGitWorktreeEntry | null = null;

  for (const outputLine of output.split("\n")) {
    const line = outputLine.trim();

    if (!line) {
      if (currentEntry?.worktreePath) {
        entries.push(currentEntry);
      }
      currentEntry = null;
      continue;
    }

    if (line.startsWith("worktree ")) {
      if (currentEntry?.worktreePath) {
        entries.push(currentEntry);
      }
      currentEntry = {
        worktreePath: line.slice("worktree ".length),
        branchRef: null,
      };
      continue;
    }

    if (line.startsWith("branch ") && currentEntry) {
      currentEntry.branchRef = line.slice("branch ".length);
    }
  }

  if (currentEntry?.worktreePath) {
    entries.push(currentEntry);
  }

  return entries;
}

function getComparableGitRefs({ ref }: { ref: string }): string[] {
  const trimmedRef = ref.trim();
  if (!trimmedRef) {
    return [];
  }

  const comparableRefs = new Set<string>([trimmedRef]);

  if (trimmedRef.startsWith("refs/heads/")) {
    comparableRefs.add(trimmedRef.slice("refs/heads/".length));
  }

  if (trimmedRef.startsWith("refs/remotes/origin/")) {
    const shortRef = trimmedRef.slice("refs/remotes/origin/".length);
    comparableRefs.add(shortRef);
    comparableRefs.add(`origin/${shortRef}`);
  }

  if (trimmedRef.startsWith("origin/")) {
    const shortRef = trimmedRef.slice("origin/".length);
    comparableRefs.add(shortRef);
    comparableRefs.add(`refs/heads/${shortRef}`);
    comparableRefs.add(`refs/remotes/origin/${shortRef}`);
  }

  if (!trimmedRef.startsWith("refs/") && !trimmedRef.startsWith("origin/")) {
    comparableRefs.add(`refs/heads/${trimmedRef}`);
    comparableRefs.add(`refs/remotes/origin/${trimmedRef}`);
  }

  return [...comparableRefs];
}

function getEnvSourceCwd({
  sourceCwd,
  baseRef,
}: {
  sourceCwd: string;
  baseRef: string;
}): string {
  try {
    const worktreeOutput = runCommand({
      command: "git",
      args: ["-C", sourceCwd, "worktree", "list", "--porcelain"],
    });
    const baseRefCandidates = new Set(getComparableGitRefs({ ref: baseRef }));
    const matchingWorktree = parseGitWorktreeList({
      output: worktreeOutput,
    }).find((worktreeEntry) => {
      if (!worktreeEntry.branchRef) {
        return false;
      }

      return getComparableGitRefs({ ref: worktreeEntry.branchRef }).some(
        (candidateRef) => baseRefCandidates.has(candidateRef),
      );
    });

    return matchingWorktree?.worktreePath ?? sourceCwd;
  } catch {
    return sourceCwd;
  }
}

async function maybeCreateWorktree({
  createBranchName,
  baseRef,
  sourceCwd,
  shouldInstall,
  shouldConfigureDoppler,
}: {
  createBranchName: string | null;
  baseRef: string;
  sourceCwd: string;
  shouldInstall: boolean;
  shouldConfigureDoppler: boolean;
}): Promise<{ worktreePath: string; usedBaseRef: string | null }> {
  if (!createBranchName) {
    return { worktreePath: sourceCwd, usedBaseRef: null };
  }

  const hasCommits = repoHasCommits({ repoCwd: sourceCwd });
  const hasResolvedBaseRef = ensureGitRefExists({
    repoCwd: sourceCwd,
    baseRef,
  });

  if (!hasResolvedBaseRef && hasCommits) {
    throw new Error(`Could not resolve base ref: ${baseRef}`);
  }

  const wtArgs = ["-C", sourceCwd, "switch", "--create", createBranchName];

  if (hasResolvedBaseRef) {
    wtArgs.push("--base", baseRef);
  }

  wtArgs.push("--yes", "--no-verify", "-x", "pwd");

  const wtOutput = runCommand({
    command: "wt",
    args: wtArgs,
  });
  const worktreePath = parseWorktreePathFromWtOutput({ output: wtOutput });

  if (!(await pathExists(worktreePath))) {
    throw new Error(
      `wt reported a worktree path that does not exist: ${worktreePath}`,
    );
  }

  const envSourceCwd = getEnvSourceCwd({
    sourceCwd,
    baseRef,
  });

  await copyEnvFileIfPresent({
    sourceCwd: envSourceCwd,
    targetCwd: worktreePath,
  });

  const reploDevName = await getReploDevNameFromSource({
    sourceCwd: envSourceCwd,
  });
  if (reploDevName) {
    await setReploDevNameInEnv({
      targetCwd: worktreePath,
      reploDevName,
    });
  }

  const reploDevEnv = await getReploDevEnvFromSource({
    sourceCwd: envSourceCwd,
  });
  if (reploDevEnv) {
    await setReploDevEnvInEnv({
      targetCwd: worktreePath,
      reploDevEnv,
    });
  }

  const dopplerAvailable =
    fs.existsSync("/opt/homebrew/bin/doppler") ||
    fs.existsSync("/usr/local/bin/doppler");

  if (shouldConfigureDoppler && dopplerAvailable) {
    try {
      runCommand({
        command: "doppler",
        args: ["configure", "set", "--scope", ".", "config", "dev_personal"],
        cwd: worktreePath,
      });
    } catch {
      // Keep the worktree usable even if doppler is unavailable or not configured.
    }
  }

  return {
    worktreePath,
    usedBaseRef: hasResolvedBaseRef ? baseRef : null,
  };
}

export async function runWorktreeCommand({
  argv,
}: {
  argv: string[];
}): Promise<void> {
  const {
    createBranchName,
    baseRef,
    cwd,
    workspaceName,
    forwardedArgs,
    shouldInstall,
    shouldConfigureDoppler,
  } = parseArgs(argv);
  const { worktreePath: worktreeCwd, usedBaseRef } = await maybeCreateWorktree({
    createBranchName,
    baseRef,
    sourceCwd: cwd,
    shouldInstall,
    shouldConfigureDoppler,
  });
  if (createBranchName) {
    maybeInstallWorkspaceDependencies({
      cwd: worktreeCwd,
      shouldInstall,
    });
  }
  const resolvedWorkspaceName =
    workspaceName ?? getDefaultWorkspaceName({ cwd: worktreeCwd });
  const createOutput = await openWorkspaceForCwd({
    cwd: worktreeCwd,
    workspaceName: resolvedWorkspaceName,
    forwardedArgs,
  });

  if (createBranchName) {
    console.log(`branch: ${createBranchName}`);
    if (usedBaseRef) {
      console.log(`base: ${usedBaseRef}`);
    } else {
      console.log("base: (none; created from unborn repo)");
    }
    console.log(`path: ${worktreeCwd}`);
  }

  console.log(createOutput);
}
