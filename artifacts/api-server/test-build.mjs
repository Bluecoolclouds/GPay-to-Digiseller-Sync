import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm } from "node:fs/promises";

globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.resolve(artifactDir, "dist-tests");

await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: [
    path.resolve(artifactDir, "src/__tests__/sync-product-types.test.ts"),
    path.resolve(artifactDir, "src/__tests__/test-environment.ts"),
  ],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir,
  outExtension: { ".js": ".mjs" },
  sourcemap: "linked",
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
  banner: {
    js: `import { createRequire as __createRequire } from "node:module";
import __path from "node:path";
import __url from "node:url";
globalThis.require = __createRequire(import.meta.url);
globalThis.__filename = __url.fileURLToPath(import.meta.url);
globalThis.__dirname = __path.dirname(globalThis.__filename);`,
  },
});