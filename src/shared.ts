import fsSync from "node:fs";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isJsonRecord, type TJsonRecord } from "./json.js";

export type TRuntimePaths = {
  projectRoot: string;
  runtimeRoot: string;
  runtimeBinDir: string;
  runtimeConfigDir: string;
  runtimeStateDir: string;
  runtimeViewerDir: string;
};

export type TCmuxCallerContext = {
  workspaceRef: string;
  paneRef: string;
  surfaceRef: string;
  tabRef: string;
};

export type TSurfaceShimState = {
  version: 2;
  workspaceRef: string;
  worktreePath: string;
  opencodePaneRef: string;
  viewerPaneRef: string | null;
  viewerSurfaceRef: string | null;
  mainSurfaceRef: string;
  mainPaneId: string;
  virtualSurfacesByPaneId: Record<
    string,
    { surfaceRef: string; hidden?: boolean }
  >;
  viewer: {
    enabled: boolean;
    siteDir: string | null;
    siteIndexPath: string | null;
    servicePid: number | null;
    controlPort: number | null;
    status: "disabled" | "starting" | "running" | "error" | "stopped";
    lastUpdatedAt: string | null;
    lastError: string | null;
  };
};

export type TCmuxHookName =
  | "after-new-workspace"
  | "after-new-split"
  | "after-new-surface";

export type TCmuxHookConfig = {
  hooks?: Partial<Record<TCmuxHookName, string[]>>;
};

export type TOpencmuxConfig = {
  defaultPromptSkills?: string[];
};

type TWorkspaceRegistry = Record<
  string,
  {
    workspaceRef: string;
    statePath: string | null;
  }
>;

type TCmuxWorkspaceTree = {
  panes: Array<{
    paneRef: string;
    surfaces: Array<{
      surfaceRef: string;
      surfaceType: string | null;
    }>;
  }>;
};

export type TWorkspaceBinding = {
  worktreePath: string;
  workspaceRef: string;
  statePath: string | null;
};

export type TWorkspaceLaunchPayload = {
  version: 1;
  forwardedArgs: string[];
  worktreePath: string | null;
};

type TWorkspaceBindingLookup = {
  worktreePath?: string;
  cwd?: string;
  workspaceRef?: string | null;
  statePath?: string;
};

type TResolvedWorkspaceBinding = TWorkspaceBinding & {
  registryWorktreePath: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function getProjectRoot(): string {
  return path.resolve(__dirname, "..");
}

export function getRuntimePaths(): TRuntimePaths {
  const projectRoot = getProjectRoot();
  const runtimeRoot = path.join(projectRoot, "runtime");

  return {
    projectRoot,
    runtimeRoot,
    runtimeBinDir: path.join(runtimeRoot, "bin"),
    runtimeConfigDir: path.join(runtimeRoot, "config"),
    runtimeStateDir: path.join(runtimeRoot, "state"),
    runtimeViewerDir: path.join(runtimeRoot, "viewer"),
  };
}

export function shellQuote(value: string): string {
  if (value.length === 0) {
    return "''";
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sanitizeHandle(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/gu, "-");
}

export function getWorkspaceStatePath({
  workspaceRef,
}: {
  workspaceRef: string;
}): string {
  return path.join(
    getRuntimePaths().runtimeStateDir,
    `${sanitizeHandle(workspaceRef)}.json`,
  );
}

export function runCommand({
  command,
  args,
  cwd,
  env,
}: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(
      [`Command failed: ${command} ${args.join(" ")}`, result.stderr.trim()]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout.trim();
}

export function isCmuxTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return [
    /Failed to write to socket/i,
    /Broken pipe/i,
    /errno 32/i,
    /\bEPIPE\b/i,
    /Failed to connect to socket/i,
    /\bECONNREFUSED\b/i,
  ].some((pattern) => pattern.test(message));
}

export function getWorkspaceTreeOutput({
  workspaceRef,
  suppressTransportErrors = false,
}: {
  workspaceRef: string;
  suppressTransportErrors?: boolean;
}): string | null {
  try {
    return runCommand({
      command: requireCommand("cmux"),
      args: ["tree", "--workspace", workspaceRef],
    });
  } catch (error) {
    if (suppressTransportErrors && isCmuxTransportError(error)) {
      return null;
    }

    throw error;
  }
}

export function installCmuxRenderRefreshHooksBestEffort(): void {
  const cmuxPath = requireCommand("cmux");
  const hookCommandBase = shellQuote(
    path.join(getRuntimePaths().runtimeBinDir, "opencmux-hook"),
  );

  for (const hookName of [
    "after-new-workspace",
    "after-new-split",
    "after-new-surface",
  ]) {
    try {
      runCommand({
        command: cmuxPath,
        args: ["set-hook", hookName, `${hookCommandBase} ${hookName}`],
      });
    } catch {
      // Ignore hook install failures and continue without the workaround.
    }
  }
}

export function refreshCmuxSurfacesBestEffort({
  workspaceRef,
}: {
  workspaceRef: string;
}): void {
  try {
    runCommand({
      command: requireCommand("cmux"),
      args: ["refresh-surfaces"],
      env: {
        ...process.env,
        CMUX_WORKSPACE_ID: workspaceRef,
      },
    });
  } catch {
    // Ignore refresh failures and continue without the workaround.
  }
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonOrNull(targetPath: string): Promise<TJsonRecord | null> {
  if (!(await pathExists(targetPath))) {
    return null;
  }

  const content = await fs.readFile(targetPath, "utf8");
  if (!content.trim()) {
    return null;
  }

  try {
    return JSON.parse(content) as TJsonRecord;
  } catch {
    return null;
  }
}

async function writeJson(
  targetPath: string,
  value: TJsonRecord,
): Promise<void> {
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function symlinkOrCopy({
  sourcePath,
  targetPath,
}: {
  sourcePath: string;
  targetPath: string;
}): Promise<void> {
  await fs.rm(targetPath, { force: true, recursive: true });
  await fs.symlink(sourcePath, targetPath);
}

function getBaseOpencodeDir(): string {
  return path.join(os.homedir(), ".config", "opencode");
}

function getBaseShadowSourceDir(): string {
  return path.join(os.homedir(), ".cmuxterm", "opencmux-config");
}

function normalizeStringArray(value: unknown): string[] {
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

export function getConfiguredOpencmuxConfig(): TOpencmuxConfig {
  const slimConfigPath = path.join(
    getBaseOpencodeDir(),
    "oh-my-opencode-slim.json",
  );

  try {
    const content = fsSync.readFileSync(slimConfigPath, "utf8");
    if (!content.trim()) {
      return {};
    }

    const parsedContent = JSON.parse(content) as unknown;
    if (!isJsonRecord(parsedContent)) {
      return {};
    }

    const opencmuxConfig = parsedContent.opencmux;
    if (!isJsonRecord(opencmuxConfig)) {
      return {};
    }

    return {
      defaultPromptSkills: normalizeStringArray(
        opencmuxConfig.defaultPromptSkills,
      ),
    };
  } catch {
    return {};
  }
}

export async function setConfiguredDefaultPromptSkills({
  skillNames,
}: {
  skillNames: string[];
}): Promise<string[]> {
  const slimConfigPath = path.join(
    getBaseOpencodeDir(),
    "oh-my-opencode-slim.json",
  );
  const normalizedSkillNames = [...new Set(normalizeStringArray(skillNames))];
  const currentConfig = (await readJsonOrNull(slimConfigPath)) ?? {};
  const nextConfig: TJsonRecord = {
    ...(isJsonRecord(currentConfig) ? currentConfig : {}),
  };
  const nextOpencmuxConfig: TJsonRecord = isJsonRecord(nextConfig.opencmux)
    ? { ...nextConfig.opencmux }
    : {};

  if (normalizedSkillNames.length > 0) {
    nextOpencmuxConfig.defaultPromptSkills = normalizedSkillNames;
  } else {
    delete nextOpencmuxConfig.defaultPromptSkills;
  }

  if (Object.keys(nextOpencmuxConfig).length > 0) {
    nextConfig.opencmux = nextOpencmuxConfig;
  } else {
    delete nextConfig.opencmux;
  }

  await fs.mkdir(getBaseOpencodeDir(), { recursive: true });
  await writeJson(slimConfigPath, nextConfig);

  return normalizedSkillNames;
}

function buildPromptSkillInstruction({
  skillNames,
}: {
  skillNames: string[];
}): string | null {
  if (skillNames.length === 0) {
    return null;
  }

  return `Use these skills when relevant and available: ${skillNames.join(", ")}.`;
}

function appendDefaultSkillsToPrompt({ prompt }: { prompt: string }): string {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    return prompt;
  }

  const promptSkillInstruction = buildPromptSkillInstruction({
    skillNames: getConfiguredOpencmuxConfig().defaultPromptSkills ?? [],
  });

  if (
    !promptSkillInstruction ||
    trimmedPrompt.includes(promptSkillInstruction)
  ) {
    return prompt;
  }

  return `${trimmedPrompt} ${promptSkillInstruction}`;
}

function getTmuxShimContent(): string {
  const projectRoot = getProjectRoot();

  return `#!/usr/bin/env bash
set -euo pipefail

case "\${1:-}" in
  -V|-v)
    echo "tmux 3.4"
    exit 0
    ;;
esac

if [ -n "\${OPENCMUX_WORKSPACE_ID:-}" ]; then
  export CMUX_WORKSPACE_ID="\${OPENCMUX_WORKSPACE_ID}"
fi

if [ -n "\${OPENCMUX_SURFACE_ID:-}" ]; then
  export CMUX_SURFACE_ID="\${OPENCMUX_SURFACE_ID}"
fi

if [ -n "\${OPENCMUX_TAB_ID:-}" ]; then
  export CMUX_TAB_ID="\${OPENCMUX_TAB_ID}"
fi

exec ${shellQuote(path.join(projectRoot, "node_modules", ".bin", "tsx"))} ${shellQuote(path.join(projectRoot, "src", "runtime", "opencmux-tmux-shim.ts"))} "$@"
`;
}

function getCmuxHookShimContent(): string {
  const projectRoot = getProjectRoot();

  return `#!/usr/bin/env bash
set -euo pipefail

exec ${shellQuote(path.join(projectRoot, "node_modules", ".bin", "tsx"))} ${shellQuote(path.join(projectRoot, "src", "runtime", "opencmux-hook.ts"))} "$@"
`;
}

export function getOpencmuxHookConfigPath(): string {
  return (
    process.env.OPENCMUX_HOOKS_CONFIG?.trim() ||
    path.join(os.homedir(), ".config", "opencmux", "hooks.json")
  );
}

function getWorktreeRegistryPath(): string {
  return path.join(
    getRuntimePaths().runtimeStateDir,
    "worktree-workspaces.json",
  );
}

function parseRefFromOutput({
  output,
  prefix,
}: {
  output: string;
  prefix: "workspace" | "pane" | "surface";
}): string {
  const match = output.match(new RegExp(`(${prefix}:\\d+)`));

  if (!match?.[1]) {
    throw new Error(`Failed to parse ${prefix} ref from: ${output}`);
  }

  return match[1];
}

function inferWorkspaceRefFromStatePath(statePath: string): string | null {
  const baseName = path.basename(statePath, path.extname(statePath));
  return /^workspace-\d+$/u.test(baseName)
    ? baseName.replace("workspace-", "workspace:")
    : null;
}

function parseWorkspaceTree({
  workspaceRef,
}: {
  workspaceRef: string;
}): TCmuxWorkspaceTree {
  const output = getWorkspaceTreeOutput({
    workspaceRef,
    suppressTransportErrors: true,
  });
  const panes: TCmuxWorkspaceTree["panes"] = [];
  let currentPane: TCmuxWorkspaceTree["panes"][number] | null = null;

  if (!output) {
    return { panes };
  }

  for (const line of output.split("\n")) {
    const paneMatch = line.match(/\bpane (pane:\d+)/);
    if (paneMatch?.[1]) {
      currentPane = {
        paneRef: paneMatch[1],
        surfaces: [],
      };
      panes.push(currentPane);
      continue;
    }

    const surfaceMatch = line.match(/\bsurface (surface:\d+) \[([^\]]+)\]/);
    if (surfaceMatch?.[1] && currentPane) {
      currentPane.surfaces.push({
        surfaceRef: surfaceMatch[1],
        surfaceType: surfaceMatch[2] ?? null,
      });
    }
  }

  return { panes };
}

async function readWorkspaceRegistry(): Promise<TWorkspaceRegistry> {
  const registry = (await readJsonOrNull(
    getWorktreeRegistryPath(),
  )) as TWorkspaceRegistry | null;

  return registry ?? {};
}

async function writeWorkspaceRegistry(
  registry: TWorkspaceRegistry,
): Promise<void> {
  await writeJson(getWorktreeRegistryPath(), registry as TJsonRecord);
}

export function workspaceExists({
  workspaceRef,
}: {
  workspaceRef: string;
}): boolean {
  try {
    return (
      getWorkspaceTreeOutput({
        workspaceRef,
        suppressTransportErrors: true,
      }) !== null
    );
  } catch {
    return false;
  }
}

function normalizeWorkspaceBinding(
  registryWorktreePath: string,
  entry: TWorkspaceRegistry[string],
): TResolvedWorkspaceBinding {
  return {
    registryWorktreePath,
    worktreePath: path.resolve(registryWorktreePath),
    workspaceRef: entry.workspaceRef,
    statePath: entry.statePath ? path.resolve(entry.statePath) : null,
  };
}

function stripWorkspaceBindingMetadata({
  registryWorktreePath: _registryWorktreePath,
  ...binding
}: TResolvedWorkspaceBinding): TWorkspaceBinding {
  return binding;
}

export async function resolveWorkspaceBinding({
  worktreePath,
  cwd,
  workspaceRef,
  statePath,
}: TWorkspaceBindingLookup): Promise<TWorkspaceBinding | null> {
  const registry = await readWorkspaceRegistry();
  const bindings = Object.entries(registry).map(
    ([registryWorktreePath, entry]) =>
      normalizeWorkspaceBinding(registryWorktreePath, entry),
  );
  let matchingBinding: TResolvedWorkspaceBinding | undefined;

  if (statePath) {
    const resolvedStatePath = path.resolve(statePath);
    matchingBinding = bindings.find(
      (binding) => binding.statePath === resolvedStatePath,
    );

    if (!matchingBinding) {
      if (workspaceRef) {
        matchingBinding = bindings.find(
          (binding) => binding.workspaceRef === workspaceRef,
        );
      }

      if (!matchingBinding) {
        const inferredWorkspaceRef =
          inferWorkspaceRefFromStatePath(resolvedStatePath);

        if (inferredWorkspaceRef) {
          matchingBinding = bindings.find(
            (binding) => binding.workspaceRef === inferredWorkspaceRef,
          );
        }
      }
    }
  } else if (workspaceRef) {
    matchingBinding = bindings.find(
      (binding) => binding.workspaceRef === workspaceRef,
    );
  } else if (worktreePath) {
    const resolvedWorktreePath = path.resolve(worktreePath);
    matchingBinding = bindings.find(
      (binding) => binding.worktreePath === resolvedWorktreePath,
    );
  } else if (cwd) {
    const resolvedCwd = path.resolve(cwd);
    matchingBinding = bindings
      .filter(
        (binding) =>
          resolvedCwd === binding.worktreePath ||
          resolvedCwd.startsWith(`${binding.worktreePath}${path.sep}`),
      )
      .sort(
        (leftBinding, rightBinding) =>
          rightBinding.worktreePath.length - leftBinding.worktreePath.length,
      )[0];
  }

  if (!matchingBinding) {
    return null;
  }

  if (!workspaceExists({ workspaceRef: matchingBinding.workspaceRef })) {
    delete registry[matchingBinding.registryWorktreePath];
    await writeWorkspaceRegistry(registry);
    return null;
  }

  return stripWorkspaceBindingMetadata(matchingBinding);
}

export function getWorkspaceAvailability({
  workspaceRef,
}: {
  workspaceRef: string;
}): "present" | "missing" | "unknown" {
  try {
    const output = getWorkspaceTreeOutput({
      workspaceRef,
      suppressTransportErrors: false,
    });
    return output !== null ? "present" : "missing";
  } catch (error) {
    if (isCmuxTransportError(error)) {
      return "unknown";
    }

    return "missing";
  }
}

export async function registerWorktreeWorkspace({
  worktreePath,
  workspaceRef,
}: {
  worktreePath: string;
  workspaceRef: string;
}): Promise<void> {
  const resolvedWorktreePath = path.resolve(worktreePath);
  const registry = await readWorkspaceRegistry();
  const existingEntry =
    registry[resolvedWorktreePath] ??
    (worktreePath !== resolvedWorktreePath
      ? registry[worktreePath]
      : undefined);

  if (worktreePath !== resolvedWorktreePath) {
    delete registry[worktreePath];
  }

  for (const [existingWorktreePath, entry] of Object.entries(registry)) {
    if (
      existingWorktreePath !== resolvedWorktreePath &&
      entry.workspaceRef === workspaceRef
    ) {
      delete registry[existingWorktreePath];
    }
  }

  registry[resolvedWorktreePath] = {
    workspaceRef,
    statePath: existingEntry?.statePath ?? null,
  };
  await writeWorkspaceRegistry(registry);
}

export async function getRegisteredWorkspaceForWorktree({
  worktreePath,
}: {
  worktreePath: string;
}): Promise<string | null> {
  return (
    (await resolveWorkspaceBinding({ worktreePath }))?.workspaceRef ?? null
  );
}

export async function updateWorktreeStatePath({
  worktreePath,
  statePath,
}: {
  worktreePath: string;
  statePath: string;
}): Promise<void> {
  const resolvedWorktreePath = path.resolve(worktreePath);
  const resolvedStatePath = path.resolve(statePath);
  const registry = await readWorkspaceRegistry();
  const existingEntry =
    registry[resolvedWorktreePath] ??
    (worktreePath !== resolvedWorktreePath
      ? registry[worktreePath]
      : undefined);

  if (!existingEntry) {
    return;
  }

  if (worktreePath !== resolvedWorktreePath) {
    delete registry[worktreePath];
  }

  for (const [existingWorktreePath, entry] of Object.entries(registry)) {
    if (
      existingWorktreePath !== resolvedWorktreePath &&
      entry.statePath === resolvedStatePath
    ) {
      delete registry[existingWorktreePath];
    }
  }

  registry[resolvedWorktreePath] = {
    workspaceRef: existingEntry.workspaceRef,
    statePath: resolvedStatePath,
  };
  await writeWorkspaceRegistry(registry);
}

export async function getRegisteredStatePathForCwd({
  cwd,
}: {
  cwd: string;
}): Promise<string | null> {
  const binding = await resolveWorkspaceBinding({ cwd });

  if (!binding?.statePath) {
    return null;
  }

  if (!(await pathExists(binding.statePath))) {
    return null;
  }

  try {
    const state = await readSurfaceShimState({ statePath: binding.statePath });

    if (!workspaceExists({ workspaceRef: state.workspaceRef })) {
      return null;
    }

    return binding.statePath;
  } catch {
    return null;
  }
}

export async function getRegisteredWorktreeForStatePath({
  statePath,
  workspaceRef,
}: {
  statePath: string;
  workspaceRef?: string | null;
}): Promise<string | null> {
  return (
    (await resolveWorkspaceBinding({ statePath, workspaceRef }))
      ?.worktreePath ?? null
  );
}

type BrowserPaneReusePolicy = "create-new" | "reuse" | "reuse-and-navigate";

export function openBrowserPane({
  workspaceRef,
  initialUrl,
  reusePolicy = "reuse-and-navigate",
}: {
  workspaceRef: string;
  initialUrl: string;
  reusePolicy?: BrowserPaneReusePolicy;
}): { paneRef: string; surfaceRef: string } {
  const existingBrowserPane = parseWorkspaceTree({ workspaceRef }).panes.find(
    (pane) =>
      pane.surfaces.some((surface) => surface.surfaceType === "browser"),
  );

  if (existingBrowserPane && reusePolicy !== "create-new") {
    const existingBrowserSurface = existingBrowserPane.surfaces.find(
      (surface) => surface.surfaceType === "browser",
    );

    if (!existingBrowserSurface) {
      throw new Error(`Failed to resolve browser surface for ${workspaceRef}`);
    }

    if (reusePolicy === "reuse-and-navigate") {
      navigateBrowserSurface({
        workspaceRef,
        surfaceRef: existingBrowserSurface.surfaceRef,
        url: initialUrl,
      });
    }

    return {
      paneRef: existingBrowserPane.paneRef,
      surfaceRef: existingBrowserSurface.surfaceRef,
    };
  }

  return createBrowserPane({ workspaceRef, initialUrl });
}

function createBrowserPane({
  workspaceRef,
  initialUrl,
}: {
  workspaceRef: string;
  initialUrl: string;
}): { paneRef: string; surfaceRef: string } {
  const output = runCommand({
    command: requireCommand("cmux"),
    args: [
      "new-pane",
      "--type",
      "browser",
      "--direction",
      "right",
      "--workspace",
      workspaceRef,
      "--url",
      initialUrl,
    ],
  });

  return {
    paneRef: parseRefFromOutput({ output, prefix: "pane" }),
    surfaceRef: parseRefFromOutput({ output, prefix: "surface" }),
  };
}

export function createTerminalPaneForWorkspace({
  workspaceRef,
  direction = "down",
}: {
  workspaceRef: string;
  direction?: "left" | "right" | "up" | "down";
}): { paneRef: string; surfaceRef: string } {
  const output = runCommand({
    command: requireCommand("cmux"),
    args: [
      "new-pane",
      "--type",
      "terminal",
      "--direction",
      direction,
      "--workspace",
      workspaceRef,
    ],
  });

  return {
    paneRef: parseRefFromOutput({ output, prefix: "pane" }),
    surfaceRef: parseRefFromOutput({ output, prefix: "surface" }),
  };
}

function navigateBrowserSurface({
  workspaceRef,
  surfaceRef,
  url,
}: {
  workspaceRef: string;
  surfaceRef: string;
  url: string;
}): void {
  runCommand({
    command: requireCommand("cmux"),
    args: ["browser", "--surface", surfaceRef, "goto", url],
    env: {
      ...process.env,
      CMUX_WORKSPACE_ID: workspaceRef,
    },
  });
}

export function reloadBrowserSurface({
  workspaceRef,
  surfaceRef,
}: {
  workspaceRef: string;
  surfaceRef: string;
}): void {
  runCommand({
    command: requireCommand("cmux"),
    args: ["browser", "--surface", surfaceRef, "reload"],
    env: {
      ...process.env,
      CMUX_WORKSPACE_ID: workspaceRef,
    },
  });
}

export function focusCmuxPane({
  workspaceRef,
  paneRef,
}: {
  workspaceRef: string;
  paneRef: string;
}): void {
  runCommand({
    command: requireCommand("cmux"),
    args: ["focus-pane", "--workspace", workspaceRef, "--pane", paneRef],
  });
}

export function sendToSurface({
  workspaceRef,
  surfaceRef,
  text,
}: {
  workspaceRef: string;
  surfaceRef: string;
  text: string;
}): void {
  runCommand({
    command: requireCommand("cmux"),
    args: ["send", "--workspace", workspaceRef, "--surface", surfaceRef, text],
  });
}

export function sendKeyToSurface({
  workspaceRef,
  surfaceRef,
  key,
}: {
  workspaceRef: string;
  surfaceRef: string;
  key: string;
}): void {
  runCommand({
    command: requireCommand("cmux"),
    args: [
      "send-key",
      "--workspace",
      workspaceRef,
      "--surface",
      surfaceRef,
      key,
    ],
  });
}

export function isGitWorkspace({ cwd }: { cwd: string }): boolean {
  try {
    runCommand({
      command: "git",
      args: ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
    });
    return true;
  } catch {
    return false;
  }
}

export async function ensureRuntimeArtifacts(): Promise<TRuntimePaths> {
  const runtimePaths = getRuntimePaths();
  const baseOpencodeDir = getBaseOpencodeDir();
  const baseShadowSourceDir = getBaseShadowSourceDir();
  const legacyBaseShadowSourceDir = path.join(
    os.homedir(),
    ".cmuxterm",
    "omo-config",
  );

  await fs.mkdir(runtimePaths.runtimeBinDir, { recursive: true });
  await fs.mkdir(runtimePaths.runtimeConfigDir, { recursive: true });
  await fs.mkdir(runtimePaths.runtimeStateDir, { recursive: true });
  await fs.mkdir(runtimePaths.runtimeViewerDir, { recursive: true });

  for (const obsoleteRuntimeBinName of ["omo-slack-media-mcp"]) {
    await fs.rm(path.join(runtimePaths.runtimeBinDir, obsoleteRuntimeBinName), {
      force: true,
    });
  }

  const dependencySourceDir = (await pathExists(
    path.join(baseShadowSourceDir, "node_modules"),
  ))
    ? baseShadowSourceDir
    : (await pathExists(path.join(legacyBaseShadowSourceDir, "node_modules")))
      ? legacyBaseShadowSourceDir
      : runtimePaths.projectRoot;

  const sourcePackageJsonPath = path.join(dependencySourceDir, "package.json");
  const sourceNodeModulesPath = path.join(dependencySourceDir, "node_modules");

  if (!(await pathExists(sourceNodeModulesPath))) {
    throw new Error(
      `Missing node_modules at ${sourceNodeModulesPath}. Run pnpm install in ${runtimePaths.projectRoot} first.`,
    );
  }

  await symlinkOrCopy({
    sourcePath: sourceNodeModulesPath,
    targetPath: path.join(runtimePaths.runtimeConfigDir, "node_modules"),
  });

  if (await pathExists(sourcePackageJsonPath)) {
    await symlinkOrCopy({
      sourcePath: sourcePackageJsonPath,
      targetPath: path.join(runtimePaths.runtimeConfigDir, "package.json"),
    });
  }

  const sourcePackageLockPath = path.join(
    dependencySourceDir,
    "package-lock.json",
  );
  if (await pathExists(sourcePackageLockPath)) {
    await symlinkOrCopy({
      sourcePath: sourcePackageLockPath,
      targetPath: path.join(runtimePaths.runtimeConfigDir, "package-lock.json"),
    });
  }

  const baseOpencodeConfigPath = path.join(baseOpencodeDir, "opencode.json");
  const baseSlimConfigPath = path.join(
    baseOpencodeDir,
    "oh-my-opencode-slim.json",
  );

  const runtimeOpencodeConfig: TJsonRecord =
    (await readJsonOrNull(baseOpencodeConfigPath)) ?? {};

  await writeJson(
    path.join(runtimePaths.runtimeConfigDir, "opencode.json"),
    runtimeOpencodeConfig,
  );

  const slimConfigTargetPath = path.join(
    runtimePaths.runtimeConfigDir,
    "oh-my-opencode-slim.json",
  );
  if (await pathExists(baseSlimConfigPath)) {
    const slimConfig = (await readJsonOrNull(baseSlimConfigPath)) ?? {};
    await writeJson(slimConfigTargetPath, slimConfig);
  }

  const runtimeTmuxConfig: TJsonRecord = {
    tmux: {
      enabled: true,
      layout: "main-vertical",
      main_pane_size: 50,
      main_pane_min_width: 60,
      agent_pane_min_width: 30,
      isolation: "inline",
    },
  };

  await writeJson(
    path.join(runtimePaths.runtimeConfigDir, "oh-my-openagent.json"),
    runtimeTmuxConfig,
  );
  await writeJson(
    path.join(runtimePaths.runtimeConfigDir, "oh-my-opencode.json"),
    runtimeTmuxConfig,
  );

  const tmuxShimPath = path.join(runtimePaths.runtimeBinDir, "tmux");
  await fs.writeFile(tmuxShimPath, getTmuxShimContent(), "utf8");
  await fs.chmod(tmuxShimPath, 0o755);

  const cmuxHookShimPath = path.join(
    runtimePaths.runtimeBinDir,
    "opencmux-hook",
  );
  await fs.writeFile(cmuxHookShimPath, getCmuxHookShimContent(), "utf8");
  await fs.chmod(cmuxHookShimPath, 0o755);

  return runtimePaths;
}

export function requireCommand(commandName: string): string {
  const commandPath = runCommand({ command: "which", args: [commandName] });

  if (!commandPath) {
    throw new Error(`Command not found: ${commandName}`);
  }

  return commandPath;
}

export function getDefaultWorkspaceName({ cwd }: { cwd: string }): string {
  try {
    const branchName = runCommand({
      command: "git",
      args: ["-C", cwd, "branch", "--show-current"],
    });

    if (branchName) {
      return `OpenCode | ${branchName}`;
    }
  } catch {
    // Ignore and fall back to directory name.
  }

  return `OpenCode | ${path.basename(cwd)}`;
}

export function applyPromptAgentDefaults({
  args,
}: {
  args: string[];
}): string[] {
  const resolvedArgs = [...args];
  const hasPrompt = args.some(
    (arg) => arg === "--prompt" || arg.startsWith("--prompt="),
  );
  const hasAgent = args.some(
    (arg) => arg === "--agent" || arg.startsWith("--agent="),
  );

  for (let index = 0; index < resolvedArgs.length; index += 1) {
    const argument = resolvedArgs[index] ?? "";

    if (argument === "--prompt") {
      const promptValue = resolvedArgs[index + 1];
      if (typeof promptValue === "string") {
        resolvedArgs[index + 1] = appendDefaultSkillsToPrompt({
          prompt: promptValue,
        });
      }
      continue;
    }

    if (argument.startsWith("--prompt=")) {
      const promptValue = argument.slice("--prompt=".length);
      resolvedArgs[index] = `--prompt=${appendDefaultSkillsToPrompt({
        prompt: promptValue,
      })}`;
    }
  }

  if (!hasPrompt || hasAgent) {
    return resolvedArgs;
  }

  return [...resolvedArgs, "--agent", "orchestrator"];
}

export function buildWorkspaceLaunchCommand({
  forwardedArgs,
  worktreePath,
}: {
  forwardedArgs: string[];
  worktreePath?: string;
}): Promise<string> {
  return buildWorkspaceLaunchCommandFromPayload({
    forwardedArgs,
    worktreePath,
  });
}

async function buildWorkspaceLaunchCommandFromPayload({
  forwardedArgs,
  worktreePath,
}: {
  forwardedArgs: string[];
  worktreePath?: string;
}): Promise<string> {
  const projectRoot = getProjectRoot();
  const tsxPath = path.join(projectRoot, "node_modules", ".bin", "tsx");
  const launcherPath = path.join(projectRoot, "src", "commands", "opencmux.ts");
  const launchPayloadPath = await writeWorkspaceLaunchPayload({
    forwardedArgs,
    worktreePath: worktreePath ?? null,
  });
  const commandParts = ["env"];

  commandParts.push(tsxPath, launcherPath);
  commandParts.push("--opencmux-launch-payload-path", launchPayloadPath);

  return commandParts.map(shellQuote).join(" ");
}

export async function writeWorkspaceLaunchPayload({
  forwardedArgs,
  worktreePath,
}: {
  forwardedArgs: string[];
  worktreePath: string | null;
}): Promise<string> {
  await ensureRuntimeArtifacts();

  const payloadPath = path.join(
    getRuntimePaths().runtimeStateDir,
    `workspace-launch-${randomUUID()}.json`,
  );
  const payload: TWorkspaceLaunchPayload = {
    version: 1,
    forwardedArgs,
    worktreePath,
  };

  await fs.writeFile(payloadPath, `${JSON.stringify(payload)}\n`, "utf8");

  return payloadPath;
}

async function createCmuxWorkspaceWithRetry({
  cmuxPath,
  workspaceName,
  cwd,
  buildCommandString,
}: {
  cmuxPath: string;
  workspaceName: string;
  cwd: string;
  buildCommandString: () => Promise<string>;
}): Promise<string> {
  const maxAttempts = 3;

  for (
    let attemptNumber = 1;
    attemptNumber <= maxAttempts;
    attemptNumber += 1
  ) {
    try {
      const commandString = await buildCommandString();

      return runCommand({
        command: cmuxPath,
        args: [
          "new-workspace",
          "--name",
          workspaceName,
          "--cwd",
          cwd,
          "--command",
          commandString,
        ],
      });
    } catch (error) {
      if (!isCmuxTransportError(error) || attemptNumber === maxAttempts) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, attemptNumber * 250));
    }
  }

  throw new Error("Failed to create cmux workspace");
}

export async function openWorkspaceForCwd({
  cwd,
  workspaceName,
  forwardedArgs,
}: {
  cwd: string;
  workspaceName: string;
  forwardedArgs: string[];
}): Promise<string> {
  const cmuxPath = requireCommand("cmux");
  const existingWorkspaceRef = (
    await resolveWorkspaceBinding({ worktreePath: cwd })
  )?.workspaceRef;

  if (existingWorkspaceRef) {
    runCommand({
      command: cmuxPath,
      args: ["select-workspace", "--workspace", existingWorkspaceRef],
    });
    return `OK ${existingWorkspaceRef} (existing)`;
  }

  const createOutput = await createCmuxWorkspaceWithRetry({
    cmuxPath,
    workspaceName,
    cwd,
    buildCommandString: () =>
      buildWorkspaceLaunchCommand({
        forwardedArgs,
        worktreePath: cwd,
      }),
  });

  const workspaceRef = parseRefFromOutput({
    output: createOutput,
    prefix: "workspace",
  });
  await registerWorktreeWorkspace({
    worktreePath: cwd,
    workspaceRef,
  });

  if (workspaceRef.startsWith("workspace:")) {
    runCommand({
      command: cmuxPath,
      args: ["select-workspace", "--workspace", workspaceRef],
    });
  }

  return createOutput;
}

export function getCanonicalRepoRoot({ cwd }: { cwd: string }): string {
  const gitCommonDir = runCommand({
    command: "git",
    args: [
      "-C",
      cwd,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
  });

  return path.dirname(gitCommonDir);
}

export function getCmuxCallerContext(): TCmuxCallerContext {
  const cmuxPath = requireCommand("cmux");
  const envWorkspaceRef =
    process.env.CMUX_WORKSPACE_ID ?? process.env.OPENCMUX_WORKSPACE_REF ?? "";
  const envSurfaceRef =
    process.env.CMUX_SURFACE_ID ?? process.env.OPENCMUX_SURFACE_REF ?? "";
  const envPaneRef = process.env.OPENCMUX_PANE_REF ?? "";
  const envTabRef =
    process.env.CMUX_TAB_ID ?? process.env.OPENCMUX_TAB_ID ?? "";
  const identifyOutput = runCommand({
    command: cmuxPath,
    args:
      envWorkspaceRef && envSurfaceRef
        ? [
            "identify",
            "--workspace",
            envWorkspaceRef,
            "--surface",
            envSurfaceRef,
            "--json",
            "--no-caller",
          ]
        : ["identify", "--json"],
  });
  const identifyResult = JSON.parse(identifyOutput) as {
    caller?: {
      workspace_ref?: string | null;
      pane_ref?: string | null;
      surface_ref?: string | null;
      tab_ref?: string | null;
    } | null;
    focused?: {
      workspace_ref?: string | null;
      pane_ref?: string | null;
      surface_ref?: string | null;
      tab_ref?: string | null;
    } | null;
  };
  const caller =
    (envWorkspaceRef && envSurfaceRef
      ? identifyResult.focused
      : identifyResult.caller) ?? identifyResult.focused;

  if (!caller?.workspace_ref || !caller.surface_ref || !caller.tab_ref) {
    throw new Error("Failed to resolve cmux caller context.");
  }

  let resolvedPaneRef =
    envPaneRef || (!envSurfaceRef ? caller.pane_ref || "" : "");

  const workspaceRefForLookup = envWorkspaceRef || caller.workspace_ref;
  const surfaceRefForLookup = envSurfaceRef || caller.surface_ref;

  if (workspaceRefForLookup && surfaceRefForLookup) {
    const treeOutput = getWorkspaceTreeOutput({
      workspaceRef: workspaceRefForLookup,
      suppressTransportErrors: true,
    });

    if (treeOutput) {
      const treeLines = treeOutput.split("\n");
      let currentPaneRef = "";
      const paneRefs = new Set<string>();

      for (const treeLine of treeLines) {
        const paneMatch = treeLine.match(/pane (pane:\d+)/);
        const surfaceMatch = treeLine.match(/\bsurface (surface:\d+) \[/);

        if (paneMatch) {
          currentPaneRef = paneMatch[1];
          paneRefs.add(currentPaneRef);
        }

        if (surfaceMatch?.[1] === surfaceRefForLookup && currentPaneRef) {
          resolvedPaneRef = currentPaneRef;
          break;
        }
      }

      if (!resolvedPaneRef && paneRefs.size === 1) {
        resolvedPaneRef = [...paneRefs][0] ?? "";
      }
    }
  }

  if (!resolvedPaneRef) {
    resolvedPaneRef = caller.pane_ref ?? "";
  }

  if (!resolvedPaneRef) {
    throw new Error("Failed to resolve cmux pane context.");
  }

  return {
    workspaceRef: caller.workspace_ref,
    paneRef: resolvedPaneRef,
    surfaceRef: caller.surface_ref,
    tabRef: caller.tab_ref,
  };
}

export async function writeSurfaceShimState({
  statePath,
  state,
}: {
  statePath: string;
  state: TSurfaceShimState;
}): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, statePath);
}

export async function readSurfaceShimState({
  statePath,
}: {
  statePath: string;
}): Promise<TSurfaceShimState> {
  const content = await fs.readFile(statePath, "utf8");

  if (!content.trim()) {
    throw new Error(`Workspace state file is empty: ${statePath}`);
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isJsonRecord(parsed)) {
      throw new Error("root value is not an object");
    }

    const viewer = isJsonRecord(parsed.viewer) ? parsed.viewer : null;
    if (
      parsed.version !== 2 ||
      typeof parsed.workspaceRef !== "string" ||
      typeof parsed.worktreePath !== "string" ||
      typeof parsed.opencodePaneRef !== "string" ||
      typeof parsed.mainSurfaceRef !== "string" ||
      !viewer ||
      typeof viewer.enabled !== "boolean" ||
      typeof viewer.status !== "string"
    ) {
      throw new Error("required state fields are missing");
    }

    return parsed as TSurfaceShimState;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Workspace state file is invalid JSON: ${statePath}\n${message}`,
    );
  }
}

export function parseReploDevName({
  envContent,
}: {
  envContent: string;
}): string | null {
  return parseEnvVariable({
    envContent,
    variableName: "REPLO_DEV_NAME",
  });
}

export function parseReploDevEnv({
  envContent,
}: {
  envContent: string;
}): string | null {
  return parseEnvVariable({
    envContent,
    variableName: "REPLO_DEV_ENV",
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseEnvVariable({
  envContent,
  variableName,
}: {
  envContent: string;
  variableName: string;
}): string | null {
  const match = envContent.match(
    new RegExp(`^${escapeRegExp(variableName)}=(.*)$`, "m"),
  );

  if (!match) {
    return null;
  }

  return match[1]?.trim() ?? null;
}

export async function getReploDevNameFromSource({
  sourceCwd,
}: {
  sourceCwd: string;
}): Promise<string | null> {
  return getEnvVariableFromSource({
    sourceCwd,
    variableName: "REPLO_DEV_NAME",
  });
}

export async function getReploDevEnvFromSource({
  sourceCwd,
}: {
  sourceCwd: string;
}): Promise<string | null> {
  return getEnvVariableFromSource({
    sourceCwd,
    variableName: "REPLO_DEV_ENV",
  });
}

async function getEnvVariableFromSource({
  sourceCwd,
  variableName,
}: {
  sourceCwd: string;
  variableName: string;
}): Promise<string | null> {
  const directEnvPath = path.join(sourceCwd, ".env");
  if (await pathExists(directEnvPath)) {
    const directEnvContent = await fs.readFile(directEnvPath, "utf8");
    const directEnvValue = parseEnvVariable({
      envContent: directEnvContent,
      variableName,
    });
    if (directEnvValue) {
      return directEnvValue;
    }
  }

  const repoRootEnvPath = path.join(
    getCanonicalRepoRoot({ cwd: sourceCwd }),
    ".env",
  );
  if (await pathExists(repoRootEnvPath)) {
    const repoRootEnvContent = await fs.readFile(repoRootEnvPath, "utf8");
    const repoRootEnvValue = parseEnvVariable({
      envContent: repoRootEnvContent,
      variableName,
    });
    if (repoRootEnvValue) {
      return repoRootEnvValue;
    }
  }

  return process.env[variableName]?.trim() ?? null;
}

export async function copyEnvFileIfPresent({
  sourceCwd,
  targetCwd,
}: {
  sourceCwd: string;
  targetCwd: string;
}): Promise<void> {
  const sourceEnvPath = path.join(sourceCwd, ".env");
  const targetEnvPath = path.join(targetCwd, ".env");

  if (!(await pathExists(sourceEnvPath))) {
    return;
  }

  if (await pathExists(targetEnvPath)) {
    return;
  }

  await fs.copyFile(sourceEnvPath, targetEnvPath);
}

export async function setReploDevNameInEnv({
  targetCwd,
  reploDevName,
}: {
  targetCwd: string;
  reploDevName: string;
}): Promise<void> {
  await setEnvVariableInEnv({
    targetCwd,
    variableName: "REPLO_DEV_NAME",
    value: reploDevName,
  });
}

export async function setReploDevEnvInEnv({
  targetCwd,
  reploDevEnv,
}: {
  targetCwd: string;
  reploDevEnv: string;
}): Promise<void> {
  await setEnvVariableInEnv({
    targetCwd,
    variableName: "REPLO_DEV_ENV",
    value: reploDevEnv,
  });
}

async function setEnvVariableInEnv({
  targetCwd,
  variableName,
  value,
}: {
  targetCwd: string;
  variableName: string;
  value: string;
}): Promise<void> {
  const targetEnvPath = path.join(targetCwd, ".env");
  const existingContent = (await pathExists(targetEnvPath))
    ? await fs.readFile(targetEnvPath, "utf8")
    : "";

  const variablePattern = new RegExp(`^${escapeRegExp(variableName)}=.*$`, "m");
  const nextContent = variablePattern.test(existingContent)
    ? existingContent.replace(variablePattern, `${variableName}=${value}`)
    : `${existingContent}${existingContent.endsWith("\n") || existingContent.length === 0 ? "" : "\n"}${variableName}=${value}\n`;

  await fs.writeFile(targetEnvPath, nextContent, "utf8");
}
