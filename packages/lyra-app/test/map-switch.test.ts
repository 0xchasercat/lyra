import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeMapService } from "../src/code-map.ts";

const saved = Bun.env.LYRA_DISABLE_CODE_MAP;
afterEach(() => {
  if (saved === undefined) delete Bun.env.LYRA_DISABLE_CODE_MAP;
  else Bun.env.LYRA_DISABLE_CODE_MAP = saved;
});

test("LYRA_DISABLE_CODE_MAP stops the graph from ever indexing", async () => {
  const root = await mkdtemp(join(tmpdir(), "map-switch-"));
  await Bun.write(join(root, "a.py"), "def f():\n  return 1\n");

  Bun.env.LYRA_DISABLE_CODE_MAP = "1";
  const off = new CodeMapService({ root });
  off.ensureStarted();
  expect(off.status().phase).toBe("unavailable");
  expect(off.status().reason).toContain("LYRA_DISABLE_CODE_MAP");

  delete Bun.env.LYRA_DISABLE_CODE_MAP;
  const on = new CodeMapService({ root });
  on.ensureStarted();
  expect(on.status().phase).not.toBe("unavailable");
});
