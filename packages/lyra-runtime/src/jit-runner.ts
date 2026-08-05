import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const target = process.argv[2];
if (!target) {
  process.stderr.write("lyra-jit-runner requires a compiled runtime module path.\n");
  process.exit(64);
}
try { await import(pathToFileURL(resolve(target)).href); }
catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }) + "\n");
  process.exitCode = 1;
}
