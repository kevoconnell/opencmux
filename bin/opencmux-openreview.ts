#!/usr/bin/env node

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type TLegacyCommand =
  | "refresh"
  | "show-overview"
  | "show-doc"
  | "status"
  | "service"
  | "stop";

const LEGACY_COMMANDS = new Set<TLegacyCommand>([
  "refresh",
  "show-overview",
  "show-doc",
  "status",
  "service",
  "stop",
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveNativeOpenReview(): Promise<string> {
  const siblingEntrypoint = path.resolve(
    __dirname,
    "../../openreview/bin/openreview",
  );

  if (await pathExists(siblingEntrypoint)) {
    return siblingEntrypoint;
  }

  return "openreview";
}

async function readRepoPathFromState(statePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as { worktreePath?: unknown };

    if (typeof parsed.worktreePath !== "string" || !parsed.worktreePath.trim()) {
      return null;
    }

    return path.resolve(parsed.worktreePath);
  } catch {
    return null;
  }
}

function parseLegacyArgs(argv: string[]): {
  command: TLegacyCommand | null;
  docName: string | null;
  repoPath: string | null;
} {
  let command: TLegacyCommand | null = null;
  let docName: string | null = null;
  let repoPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (argument === "--state") {
      const statePath = argv[index + 1] ?? "";
      if (!statePath) {
        throw new Error("Missing value for --state");
      }

      repoPath = path.resolve(statePath);
      index += 1;
      continue;
    }

    if (argument.startsWith("--state=")) {
      repoPath = path.resolve(argument.slice("--state=".length));
      continue;
    }

    if (!command && LEGACY_COMMANDS.has(argument as TLegacyCommand)) {
      command = argument as TLegacyCommand;
      continue;
    }

    if (command === "show-doc" && !docName && !argument.startsWith("-")) {
      docName = argument;
    }
  }

  return { command, docName, repoPath };
}

async function main(): Promise<void> {
  const nativeOpenReview = await resolveNativeOpenReview();
  const rawArgs = process.argv.slice(2);
  const { command, docName, repoPath: statePath } = parseLegacyArgs(rawArgs);
  const inferredRepoPath = statePath
    ? await readRepoPathFromState(statePath)
    : null;

  if (command === "stop") {
    console.error("openreview stop is a no-op with the native CLI.");
    process.exit(0);
  }

  const nativeArgs: string[] = [];

  switch (command) {
    case null:
      nativeArgs.push("show-overview");
      break;
    case "refresh":
      nativeArgs.push("refresh");
      break;
    case "show-overview":
      nativeArgs.push("show-overview");
      break;
    case "show-doc":
      nativeArgs.push("show-doc");
      break;
    case "status":
      nativeArgs.push("status");
      break;
    case "service":
      nativeArgs.push("refresh");
      break;
  }

  if (inferredRepoPath) {
    nativeArgs.push("--local", inferredRepoPath);
  }

  if (command === "show-doc" && docName) {
    nativeArgs.push(docName);
  }

  const child = spawn(nativeOpenReview, nativeArgs, {
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
