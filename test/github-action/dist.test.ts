import { readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// The runner runs github-action/dist/index.js, never the TypeScript, so the committed bundle must be exactly what the source builds to.
// This rebuilds it in memory with the same options as `npm run build:action` and fails on any difference: run that script and commit.
describe("github-action/dist", () => {
  it("is the bundle the source builds to", async () => {
    const root = join(import.meta.dirname, "..", "..");
    const result = await build({
      entryPoints: [join(root, "github-action/src/index.ts")],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "esm",
      legalComments: "none",
      write: false,
      outfile: join(root, "github-action/dist/index.js"),
      absWorkingDir: root,
    });
    const built = result.outputFiles[0]!.text;
    const committed = readFileSync(join(root, "github-action/dist/index.js"), "utf8");
    expect(committed === built, "github-action/dist/index.js is stale: run npm run build:action and commit it").toBe(true);
  });
});
