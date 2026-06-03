/**
 * memory-xx HTTP wrapper - thin entry point
 *
 * HTTP server mode (default): tsx scripts/memory-xx-wrapper.ts
 * CLI mode: tsx scripts/memory-xx-wrapper.ts recall --query "..."
 */

import { runServer, runCli } from "../app/server";

const args = process.argv.slice(2);

if (args.length === 0) {
  runServer().catch((err) => {
    console.error(JSON.stringify({ level: "ERROR", message: err.message }));
    process.exit(1);
  });
} else {
  runCli(process.argv).catch((err) => {
    console.error(JSON.stringify({ level: "ERROR", message: err.message }));
    process.exit(1);
  });
}
