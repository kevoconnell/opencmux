#!/usr/bin/env node

import { ensureOpenCodeServerForCwd } from "../src/opencode-server.js";

async function main(): Promise<void> {
  const server = await ensureOpenCodeServerForCwd();
  process.stdout.write(`${server.baseUrl}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
