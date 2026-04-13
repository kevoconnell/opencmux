import fs from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { getProjectRoot, getRuntimePaths, pathExists, requireCommand } from "./shared.js";

export const OPENCODE_SERVER_URL = "http://127.0.0.1:4096";

type TEnsureOpenCodeServerForCwdLifecycle =
  | {
      kind: "reused";
    }
  | {
      kind: "started";
    }
  | {
      kind: "restarted";
      restart: {
        fromCwd: string | null;
      };
    };

export type TEnsureOpenCodeServerForCwdResult = {
  baseUrl: string;
  cwd: string;
  lifecycle: TEnsureOpenCodeServerForCwdLifecycle;
};

type TOpencodeServerState = {
  pid: number | null;
  baseUrl: string;
  cwd: string;
  startedAt: string;
};

function getServerStatePath(): string {
  return path.join(getRuntimePaths().runtimeStateDir, "opencode-server.json");
}

async function isHealthy(url: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const parsedUrl = new URL(url);
    const request = (parsedUrl.protocol === "https:" ? https : http).request(
      parsedUrl,
      {
        method: "GET",
        timeout: 3000,
        headers: {
          Accept: "application/json",
          Connection: "close",
        },
      },
      (response) => {
        response.resume();
        resolve(
          (response.statusCode ?? 500) >= 200 &&
            (response.statusCode ?? 500) < 300,
        );
      },
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
    request.end();
  });
}

async function readServerState(): Promise<TOpencodeServerState | null> {
  const statePath = getServerStatePath();
  if (!(await pathExists(statePath))) {
    return null;
  }

  try {
    const content = await fs.readFile(statePath, "utf8");
    if (!content.trim()) {
      return null;
    }
    return JSON.parse(content) as TOpencodeServerState;
  } catch {
    return null;
  }
}

async function writeServerState(state: TOpencodeServerState): Promise<void> {
  const statePath = getServerStatePath();
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, statePath);
}

async function readServerCwd(baseUrl: string): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const parsedUrl = new URL(`${baseUrl}/path`);
    const request = (parsedUrl.protocol === "https:" ? https : http).request(
      parsedUrl,
      {
        method: "GET",
        timeout: 3000,
        headers: {
          Accept: "application/json",
          Connection: "close",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              cwd?: string;
              directory?: string;
              worktree?: string;
            };
            resolve(payload.cwd ?? payload.directory ?? payload.worktree ?? null);
          } catch {
            resolve(null);
          }
        });
      },
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => resolve(null));
    request.end();
  });
}

function killServerOnPort(): void {
  try {
    const result = spawnSync("lsof", ["-ti", "tcp:4096"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = (result.stdout || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number.parseInt(pid, 10), "SIGTERM");
      } catch {
        // ignore stale pid
      }
    }
  } catch {
    // ignore
  }
}

export async function ensureOpenCodeServerForCwd({
  cwd = getProjectRoot(),
}: {
  cwd?: string;
} = {}): Promise<TEnsureOpenCodeServerForCwdResult> {
  const baseUrl = OPENCODE_SERVER_URL;
  const healthUrl = `${baseUrl}/global/health`;
  const priorState = await readServerState();
  const wasHealthy = await isHealthy(healthUrl);
  const liveCwd = wasHealthy && priorState?.cwd !== cwd ? await readServerCwd(baseUrl) : null;

  if (wasHealthy) {
    if (priorState?.cwd === cwd || liveCwd === cwd) {
      return {
        baseUrl,
        cwd,
        lifecycle: {
          kind: "reused",
        },
      };
    }
  }

  const restartFromCwd = liveCwd ?? priorState?.cwd ?? null;
  killServerOnPort();

  const runtimeConfigDir = getRuntimePaths().runtimeConfigDir;
  const child = spawn(
    requireCommand("opencode"),
    ["serve", "--port", "4096", "--hostname", "127.0.0.1"],
    {
      detached: true,
      stdio: "ignore",
      cwd,
      env: {
        ...process.env,
        OPENCODE_BASE_URL: baseUrl,
        OPENCODE_CONFIG_DIR: runtimeConfigDir,
        OPENCODE_CONFIG: path.join(runtimeConfigDir, "opencode.json"),
      },
    },
  );
  child.unref();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await isHealthy(healthUrl)) {
      await writeServerState({
        pid: child.pid ?? null,
        baseUrl,
        cwd,
        startedAt: new Date().toISOString(),
      });
      return {
        baseUrl,
        cwd,
        lifecycle: wasHealthy
          ? {
              kind: "restarted",
              restart: {
                fromCwd: restartFromCwd,
              },
            }
          : {
              kind: "started",
            },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(
    `OpenCode server did not become healthy at ${healthUrl}${priorState ? ` (previous cwd: ${priorState.cwd})` : ""}`,
  );
}
