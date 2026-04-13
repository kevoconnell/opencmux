#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  refreshCmuxSurfacesBestEffort,
  readSurfaceShimState,
  requireCommand,
  runCommand,
  writeSurfaceShimState,
} from "../src/shared.js";

type TSplitCommand = {
  printPaneId: boolean;
  targetPaneId: string | null;
  commandText: string | null;
};

type TVirtualSurfaceMapping = {
  surfaceRef: string;
  hidden?: boolean;
};

function getStatePath(): string {
  const statePath = process.env.OPENCMUX_STATE_PATH ?? "";

  if (!statePath) {
    throw new Error("OPENCMUX_STATE_PATH is not set.");
  }

  return statePath;
}

function getCommandParts(): string[] {
  return process.argv.slice(2);
}

function getTargetPaneId({
  commandParts,
}: {
  commandParts: string[];
}): string | null {
  const targetIndex = commandParts.findIndex(
    (commandPart) => commandPart === "-t",
  );

  if (targetIndex === -1) {
    return null;
  }

  return commandParts[targetIndex + 1] ?? null;
}

function getMappedSurfaceRef({
  virtualSurfacesByPaneId,
  paneId,
}: {
  virtualSurfacesByPaneId: Record<string, TVirtualSurfaceMapping>;
  paneId: string | null;
}): string | null {
  if (!paneId) {
    return null;
  }

  return virtualSurfacesByPaneId[paneId]?.surfaceRef ?? null;
}

function getMappedSurfaceEntry({
  virtualSurfacesByPaneId,
  paneId,
}: {
  virtualSurfacesByPaneId: Record<string, TVirtualSurfaceMapping>;
  paneId: string | null;
}): TVirtualSurfaceMapping | null {
  if (!paneId) {
    return null;
  }

  return virtualSurfacesByPaneId[paneId] ?? null;
}

function shouldHideChildSurfaces(): boolean {
  return process.env.OPENCMUX_HIDE_TMUX_CHILD_SURFACES === "1";
}

function parseSplitCommand({
  commandParts,
}: {
  commandParts: string[];
}): TSplitCommand {
  let printPaneId = false;
  let targetPaneId: string | null = null;
  const remainingCommandParts: string[] = [];

  for (let index = 1; index < commandParts.length; index += 1) {
    const commandPart = commandParts[index];

    if (commandPart === "-P") {
      printPaneId = true;
      continue;
    }

    if (commandPart === "-F") {
      index += 1;
      continue;
    }

    if (commandPart === "-t") {
      targetPaneId = commandParts[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (commandPart.startsWith("-")) {
      continue;
    }

    remainingCommandParts.push(...commandParts.slice(index));
    break;
  }

  return {
    printPaneId,
    targetPaneId,
    commandText:
      remainingCommandParts.length > 0 ? remainingCommandParts.join(" ") : null,
  };
}

async function createSurfaceForCommand({
  commandText,
}: {
  commandText: string | null;
}): Promise<void> {
  const statePath = getStatePath();
  const state = await readSurfaceShimState({ statePath });
  const cmuxPath = requireCommand("cmux");
  const shouldHideChildSurface = shouldHideChildSurfaces();
  const newSurfaceOutput = runCommand({
    command: cmuxPath,
    args: [
      "new-surface",
      "--workspace",
      state.workspaceRef,
      "--pane",
      state.opencodePaneRef,
    ],
  });
  const surfaceRefMatch = newSurfaceOutput.match(/(surface:\d+)/);

  if (!surfaceRefMatch) {
    throw new Error(`Failed to parse surface ref from: ${newSurfaceOutput}`);
  }

  const nextPaneId = `%opencmux-${randomUUID()}`;
  state.virtualSurfacesByPaneId[nextPaneId] = {
    surfaceRef: surfaceRefMatch[1],
    hidden: shouldHideChildSurface,
  };
  await writeSurfaceShimState({ statePath, state });

  if (commandText) {
    runCommand({
      command: cmuxPath,
      args: [
        "send",
        "--workspace",
        state.workspaceRef,
        "--surface",
        surfaceRefMatch[1],
        `${commandText}\n`,
      ],
    });
  }

  if (!shouldHideChildSurface) {
    refreshCmuxSurfacesBestEffort({ workspaceRef: state.workspaceRef });
  }

  const { printPaneId } = parseSplitCommand({
    commandParts: getCommandParts(),
  });
  if (printPaneId) {
    process.stdout.write(`${nextPaneId}\n`);
  }
}

async function renameSurfaceFromPaneId({
  paneId,
  title,
}: {
  paneId: string | null;
  title: string | null;
}): Promise<void> {
  if (!paneId || !title) {
    return;
  }

  const state = await readSurfaceShimState({ statePath: getStatePath() });
  const surfaceEntry = getMappedSurfaceEntry({
    virtualSurfacesByPaneId: state.virtualSurfacesByPaneId,
    paneId,
  });

  if (!surfaceEntry || surfaceEntry.hidden) {
    return;
  }

  const surfaceRef = surfaceEntry.surfaceRef;

  runCommand({
    command: requireCommand("cmux"),
    args: [
      "rename-tab",
      "--workspace",
      state.workspaceRef,
      "--surface",
      surfaceRef,
      title,
    ],
  });
}

async function sendKeysToPane({
  paneId,
  keyNames,
}: {
  paneId: string | null;
  keyNames: string[];
}): Promise<void> {
  if (!paneId) {
    return;
  }

  const state = await readSurfaceShimState({ statePath: getStatePath() });
  const surfaceRef = getMappedSurfaceRef({
    virtualSurfacesByPaneId: state.virtualSurfacesByPaneId,
    paneId,
  });

  if (!surfaceRef) {
    return;
  }

  const cmuxPath = requireCommand("cmux");
  let textBuffer = "";

  const flushTextBuffer = () => {
    if (textBuffer.length === 0) {
      return;
    }

    runCommand({
      command: cmuxPath,
      args: [
        "send",
        "--workspace",
        state.workspaceRef,
        "--surface",
        surfaceRef,
        textBuffer,
      ],
    });
    textBuffer = "";
  };

  for (const keyName of keyNames) {
    if (keyName === "C-c" || keyName === "ctrl+c") {
      flushTextBuffer();
      runCommand({
        command: cmuxPath,
        args: [
          "send-key",
          "--workspace",
          state.workspaceRef,
          "--surface",
          surfaceRef,
          "ctrl+c",
        ],
      });
      continue;
    }

    if (keyName === "Enter" || keyName === "enter") {
      flushTextBuffer();
      runCommand({
        command: cmuxPath,
        args: [
          "send-key",
          "--workspace",
          state.workspaceRef,
          "--surface",
          surfaceRef,
          "enter",
        ],
      });
      continue;
    }

    textBuffer += keyName;
  }

  flushTextBuffer();
}

async function closePaneSurface({
  paneId,
}: {
  paneId: string | null;
}): Promise<void> {
  if (!paneId) {
    return;
  }

  const statePath = getStatePath();
  const state = await readSurfaceShimState({ statePath });
  const surfaceRef = getMappedSurfaceRef({
    virtualSurfacesByPaneId: state.virtualSurfacesByPaneId,
    paneId,
  });

  if (!surfaceRef || surfaceRef === state.mainSurfaceRef) {
    return;
  }

  runCommand({
    command: requireCommand("cmux"),
    args: [
      "close-surface",
      "--workspace",
      state.workspaceRef,
      "--surface",
      surfaceRef,
    ],
  });

  delete state.virtualSurfacesByPaneId[paneId];
  await writeSurfaceShimState({ statePath, state });
}

async function respawnPaneSurface({
  paneId,
  commandText,
}: {
  paneId: string | null;
  commandText: string | null;
}): Promise<void> {
  if (!paneId || !commandText) {
    return;
  }

  await sendKeysToPane({ paneId, keyNames: ["C-c"] });

  const state = await readSurfaceShimState({ statePath: getStatePath() });
  const surfaceRef = getMappedSurfaceRef({
    virtualSurfacesByPaneId: state.virtualSurfacesByPaneId,
    paneId,
  });

  if (!surfaceRef) {
    return;
  }

  runCommand({
    command: requireCommand("cmux"),
    args: [
      "send",
      "--workspace",
      state.workspaceRef,
      "--surface",
      surfaceRef,
      `${commandText}\n`,
    ],
  });
}

async function capturePane({
  paneId,
}: {
  paneId: string | null;
}): Promise<void> {
  const state = await readSurfaceShimState({ statePath: getStatePath() });
  const surfaceRef =
    getMappedSurfaceRef({
      virtualSurfacesByPaneId: state.virtualSurfacesByPaneId,
      paneId,
    }) ?? state.mainSurfaceRef;
  const output = runCommand({
    command: requireCommand("cmux"),
    args: [
      "read-screen",
      "--workspace",
      state.workspaceRef,
      "--surface",
      surfaceRef,
      "--scrollback",
      "--lines",
      "400",
    ],
  });

  process.stdout.write(output);
}

function handleDisplayCommand({
  commandParts,
}: {
  commandParts: string[];
}): void {
  if (commandParts.includes("#{window_width},#{window_height}")) {
    process.stdout.write("200,60\n");
    return;
  }

  if (commandParts.includes("#{pane_id}")) {
    process.stdout.write(`${process.env.TMUX_PANE ?? "%opencmux-main"}\n`);
  }
}

async function main(): Promise<void> {
  const commandParts = getCommandParts();
  const subcommand = commandParts[0] ?? "";

  switch (subcommand) {
    case "split-window":
    case "new-window":
    case "new-session": {
      const splitCommand = parseSplitCommand({ commandParts });
      await createSurfaceForCommand({ commandText: splitCommand.commandText });
      return;
    }
    case "select-pane": {
      const targetPaneId = getTargetPaneId({ commandParts });
      const titleIndex = commandParts.findIndex(
        (commandPart) => commandPart === "-T",
      );
      const title =
        titleIndex === -1 ? null : (commandParts[titleIndex + 1] ?? null);
      await renameSurfaceFromPaneId({ paneId: targetPaneId, title });
      return;
    }
    case "send-keys": {
      const targetPaneId = getTargetPaneId({ commandParts });
      const keyStartIndex = (() => {
        const targetIndex = commandParts.findIndex(
          (commandPart) => commandPart === "-t",
        );
        return targetIndex === -1 ? 1 : targetIndex + 2;
      })();
      await sendKeysToPane({
        paneId: targetPaneId,
        keyNames: commandParts.slice(keyStartIndex),
      });
      return;
    }
    case "kill-pane": {
      await closePaneSurface({ paneId: getTargetPaneId({ commandParts }) });
      return;
    }
    case "respawn-pane": {
      const targetPaneId = getTargetPaneId({ commandParts });
      const commandText = commandParts.at(-1) ?? null;
      await respawnPaneSurface({ paneId: targetPaneId, commandText });
      return;
    }
    case "capture-pane": {
      await capturePane({ paneId: getTargetPaneId({ commandParts }) });
      return;
    }
    case "display-message":
    case "display": {
      handleDisplayCommand({ commandParts });
      return;
    }
    case "has-session": {
      process.exit(1);
    }
    case "select-layout":
    case "set-window-option":
    case "resize-pane":
    case "wait-for":
    case "set-hook":
    case "last-pane":
    case "bind-key":
    case "unbind-key":
    case "copy-mode":
    case "popup":
    case "set-buffer":
    case "list-buffers":
    case "paste-buffer":
    case "clear-history": {
      return;
    }
    default: {
      throw new Error(`Unsupported tmux shim command: ${subcommand}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
