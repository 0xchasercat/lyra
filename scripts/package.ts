import { chmod, copyFile, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

/**
 * Builds one platform bundle: `lyra` (the daemon and entry point), `lyra-tui`
 * (the terminal client it spawns), and the JIT runner.
 *
 * The two binaries must land in the *same directory*: interactive `lyra`
 * resolves `lyra-tui` as a sibling of its own executable, so the layout here is
 * load-bearing, not cosmetic.
 *
 * The canonical ACP schema needs no copy step — `@lyra/acp` imports
 * `schema/protocol.json` as a module, so `bun build --compile` embeds it. A
 * path-relative read would resolve inside the repo and fail in the bundle.
 */
const root = resolve(import.meta.dir, "..");
const platform = `${process.platform}-${process.arch}`;
const extension = process.platform === "win32" ? ".exe" : "";
const bundle = join(root, "dist", `lyra-${platform}`);
const install = process.argv.includes("--install");

await rm(bundle, { recursive: true, force: true });
await mkdir(bundle, { recursive: true, mode: 0o755 });
// The Rust client is part of `bun run build`, not a separate step someone can forget:
// a bundle whose `lyra-tui` is stale or missing has no interactive mode at all.
await run(["cargo", "build", "--release", "-q", "-p", "lyra-tui", "--bin", "lyra-tui"]);
await run([process.execPath, "build", "--compile", "packages/lyra-app/src/cli.ts", "--outfile", join(bundle, `lyra${extension}`)]);
await run([process.execPath, "build", "--compile", "packages/lyra-runtime/src/jit-runner.ts", "--outfile", join(bundle, `lyra-jit-runner${extension}`)]);
await copyFile(join(root, "target", "release", `lyra-tui${extension}`), join(bundle, `lyra-tui${extension}`));
await copyFile(join(root, "packages", "lyra-runtime", "src", "runtime-client.ts"), join(bundle, "runtime-client.ts"));
for (const file of [`lyra${extension}`, `lyra-jit-runner${extension}`, `lyra-tui${extension}`]) await chmod(join(bundle, file), 0o755);
const appPackage = JSON.parse(await readFile(join(root, "packages", "lyra-app", "package.json"), "utf8")) as { version: string };
await writeFile(join(bundle, "manifest.json"), `${JSON.stringify({ name: "lyra", version: appPackage.version, platform, files: [`lyra${extension}`, `lyra-jit-runner${extension}`, `lyra-tui${extension}`, "runtime-client.ts"] }, null, 2)}\n`, { mode: 0o644 });

if (install) {
  if (process.platform === "win32") throw new Error("Local installer currently supports macOS and Linux; copy the bundle directory onto PATH on Windows.");
  const installRoot = join(homedir(), ".local", "lib", "lyra", `${appPackage.version}-${platform}`);
  await rm(installRoot, { recursive: true, force: true });
  await mkdir(installRoot, { recursive: true, mode: 0o755 });
  for (const file of [`lyra${extension}`, `lyra-jit-runner${extension}`, `lyra-tui${extension}`, "runtime-client.ts", "manifest.json"]) await copyFile(join(bundle, file), join(installRoot, file));
  const binRoot = join(homedir(), ".local", "bin");
  const link = join(binRoot, "lyra");
  await mkdir(binRoot, { recursive: true, mode: 0o755 });
  await unlink(link).catch(() => undefined);
  await symlink(relative(binRoot, join(installRoot, "lyra")), link);
  process.stdout.write(`Installed ${link} -> ${await realpath(join(installRoot, "lyra"))}\n`);
} else process.stdout.write(`Built ${relative(root, bundle)}/\nRun ${relative(root, join(bundle, `lyra${extension}`))}\n`);

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${basename(command[0]!)} exited with ${code}.`);
}
