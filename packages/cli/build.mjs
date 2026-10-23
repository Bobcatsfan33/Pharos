// Build the single-file CLI bundle.
//
// The workspace packages (@pharos/core, storage, cascade, policy, judge, evidence, config,
// identity, observability, api, …) are private and export TypeScript source, so the
// published CLI inlines them. What is NOT inlined, and why:
//   - fastify / @fastify/cors      real dependencies of @getpharos/cli (dynamic requires;
//                                   bundling them is fragile)
//   - pg, ioredis, @aws-sdk/*       the Postgres/S3/KMS production path; reached only through
//                                   dynamic imports in the composition root, emitted as
//                                   separate chunks, and NOT dependencies of the CLI — the
//                                   embedded on-ramp never loads them. `pharos serve
//                                   --backend postgres` tells the user what to install.
//   - onnxruntime-node             the transformer judges' native runtime; lazily imported by
//                                   @pharos/judge only on the ONNX path.
// The build refuses to ship if any of those appears as a static import in the entry chunk.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

const LAZY_ONLY = [
  "pg",
  "pg-pool",
  "ioredis",
  "@aws-sdk/client-s3",
  "@aws-sdk/client-kms",
  "onnxruntime-node",
];
const external = [...Object.keys(pkg.dependencies), ...LAZY_ONLY, "@smithy/*", "@aws-sdk/*"];

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "bin"), { recursive: true });

// esbuild cannot read an uninstalled package's manifest, so it must assume an external import
// has side effects and keep it even when nothing uses its bindings. Declaring the lazy-only
// modules side-effect free lets tree-shaking drop the dead imports from the embedded graph;
// the Postgres/AWS chunks that really use them keep them.
const lazyOnlyPlugin = {
  name: "lazy-only-externals",
  setup(b) {
    b.onResolve(
      { filter: /^(pg|pg-pool|ioredis|onnxruntime-node|@aws-sdk\/.+|@smithy\/.+)$/ },
      (args) => ({
        path: args.path,
        external: true,
        sideEffects: false,
      }),
    );
  },
};

await build({
  plugins: [lazyOnlyPlugin],
  entryPoints: { "bin/pharos": join(here, "src/main.ts") },
  outdir: dist,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  chunkNames: "chunks/[name]-[hash]",
  outExtension: { ".js": ".mjs" },
  external,
  define: { "process.env.PHAROS_CLI_VERSION": JSON.stringify(pkg.version) },
  // CommonJS dependencies (pkijs → @noble/hashes) call require(); give ESM output a real one.
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __pharosCreateRequire } from "node:module";\nconst require = __pharosCreateRequire(import.meta.url);\n',
  },
  legalComments: "none",
  logLevel: "warning",
});

// Judge model artifacts: @pharos/judge resolves `../models` relative to the bundle, so the
// committed linear models (and the ONNX manifest) ship under dist/models.
const modelsSrc = join(here, "../judge/models");
cpSync(modelsSrc, join(dist, "models"), { recursive: true });

// Refuse to ship a bundle in which the entry, or any chunk the entry imports statically,
// imports a lazy-only module: the embedded on-ramp must load with none of them installed.
// Statement-level scan: esbuild may wrap long binding lists across lines, so collapse the
// braces before matching. Dynamic `import("x")` calls are deliberately NOT matched.
const staticImports = (file) => {
  const src = readFileSync(file, "utf8").replace(/\{[^}]*\}/gs, "{}");
  return [...src.matchAll(/^(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
};
const seen = new Set();
const queue = [join(dist, "bin/pharos.mjs")];
const leaked = new Set();
while (queue.length > 0) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  for (const spec of staticImports(file)) {
    if (spec.startsWith(".")) queue.push(join(dirname(file), spec));
    else if (
      LAZY_ONLY.some((m) => spec === m || spec.startsWith(`${m}/`)) ||
      /^@(aws-sdk|smithy)\//.test(spec)
    )
      leaked.add(spec);
  }
}
if (leaked.size > 0) {
  console.error(
    `the embedded entry graph statically imports lazy-only modules: ${[...leaked].join(", ")}`,
  );
  process.exit(1);
}
const files = readdirSync(join(dist, "bin")).concat(
  readdirSync(join(dist, "chunks")).map((f) => `chunks/${f}`),
);
console.log(`built @getpharos/cli ${pkg.version}: ${files.length} files under dist/`);
