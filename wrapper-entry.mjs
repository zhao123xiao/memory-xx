import { runServer, runCli } from "./dist/app/server/index.js";

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
