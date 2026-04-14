import type { ChildProcess } from "node:child_process";
import process from "node:process";

export function formatCliError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function failCli(error: unknown): never {
  console.error(formatCliError(error));
  process.exit(1);
}

export function forwardChildExit(child: ChildProcess): void {
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  child.on("error", failCli);
}

export function runCli(main: () => Promise<void>): void {
  void main().catch(failCli);
}
