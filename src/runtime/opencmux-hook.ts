#!/usr/bin/env node

import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { runCli } from "../cli.js";
import {
  getOpencmuxHookConfigPath,
  type TCmuxHookConfig,
  type TCmuxHookName,
  requireCommand,
  runCommand,
} from "../shared.js";

const BUILTIN_REFRESH_HOOKS = new Set<TCmuxHookName>([
  "after-new-workspace",
  "after-new-split",
  "after-new-surface",
]);

function getHookName(): TCmuxHookName {
  const hookName = process.argv[2] ?? "";
  if (!BUILTIN_REFRESH_HOOKS.has(hookName as TCmuxHookName)) {
    throw new Error(`Unsupported cmux hook: ${hookName || "(missing)"}`);
  }

  return hookName as TCmuxHookName;
}

async function readHookConfig(): Promise<TCmuxHookConfig> {
  const configPath = getOpencmuxHookConfigPath();

  try {
    const content = await fs.readFile(configPath, "utf8");
    if (!content.trim()) {
      return {};
    }

    return JSON.parse(content) as TCmuxHookConfig;
  } catch {
    return {};
  }
}

function getHookCommandsFromEnv(hookName: TCmuxHookName): string[] {
  const variants = [
    `OPENCMUX_${hookName.replaceAll("-", "_").toUpperCase()}_HOOK`,
    `OPENCMUX_HOOK_${hookName.replaceAll("-", "_").toUpperCase()}`,
  ];

  return variants
    .map((name) => process.env[name]?.trim() ?? "")
    .filter(Boolean);
}

function normalizeHookCommands(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

async function getHookCommands(hookName: TCmuxHookName): Promise<string[]> {
  const config = await readHookConfig();
  const configCommands = normalizeHookCommands(config.hooks?.[hookName]);
  const envCommands = getHookCommandsFromEnv(hookName);
  return [...configCommands, ...envCommands];
}

function refreshSurfacesBestEffort(): void {
  const workspaceRef =
    process.env.CMUX_WORKSPACE_ID?.trim() ||
    process.env.OPENCMUX_WORKSPACE_ID?.trim() ||
    process.env.OPENCMUX_WORKSPACE_REF?.trim() ||
    null;

  try {
    runCommand({
      command: requireCommand("cmux"),
      args: ["refresh-surfaces"],
      env: workspaceRef
        ? {
            ...process.env,
            CMUX_WORKSPACE_ID: workspaceRef,
          }
        : process.env,
    });
  } catch {
    // Ignore refresh failures; custom hooks should still run.
  }
}

function resolveHookCwd(): string {
  const worktreePath = process.env.OPENCMUX_WORKTREE_PATH?.trim();
  if (worktreePath) {
    return worktreePath;
  }

  const pwd = process.env.PWD?.trim();
  if (pwd) {
    return pwd;
  }

  return process.cwd();
}

function runHookCommand({
  hookName,
  command,
  cwd,
}: {
  hookName: TCmuxHookName;
  command: string;
  cwd: string;
}): void {
  const result = spawnSync("sh", ["-lc", command], {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCMUX_HOOK_NAME: hookName,
      OPENCMUX_HOOK_CWD: cwd,
      OPENCMUX_HOOK_CONFIG_PATH: getOpencmuxHookConfigPath(),
    },
  });

  if (result.status === 0) {
    return;
  }

  const detail =
    result.error?.message ||
    `Command exited with status ${String(result.status ?? "unknown")}`;
  console.error(`[opencmux hook] ${hookName} failed: ${command}`);
  console.error(detail);
}

async function main(): Promise<void> {
  const hookName = getHookName();
  const cwd = resolveHookCwd();

  if (BUILTIN_REFRESH_HOOKS.has(hookName)) {
    refreshSurfacesBestEffort();
  }

  for (const command of await getHookCommands(hookName)) {
    runHookCommand({ hookName, command, cwd });
  }
}

runCli(main);
