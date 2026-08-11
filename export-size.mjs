// Measure the published export sizes of one or more npm packages with esbuild.
//
// Each package's public surface is bundled with every bare dependency (peers,
// third-party) left external and the output minified, then measured raw, gzipped
// and brotli-compressed. Dynamic `import()` calls are split out and excluded:
// only the code that loads eagerly with the export counts. Two modes are
// supported:
//
//   named-exports  Size each named export as it is consumed from the barrel
//                  (`import { X } from '<pkg>'`), by tree-shaking that single
//                  symbol out of the built barrel. A symbol reachable from
//                  several places is measured once (same code, same size).
//   subpaths       Size each explicit subpath export from its own entry.
//
// Configured through the environment:
//   EXPORT_SIZE_PACKAGES  `name:dir` pairs, one per line or comma-separated
//                         (e.g. `@studiometa/ui:packages/ui`). `dir` alone is
//                         also accepted; the name is then read from package.json.
//   EXPORT_SIZE_MODE      `named-exports` (default) or `subpaths`.
//   EXPORT_SIZE_ROOT      Repository root the dirs are relative to (default cwd).
//
// The packages must be built first. Pass `--json <path>` to also write the raw
// report as JSON (consumed by export-size-comment.mjs).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = process.env.EXPORT_SIZE_ROOT || process.cwd();
const mode = process.env.EXPORT_SIZE_MODE || 'named-exports';

const jsonArg = process.argv.indexOf('--json');
const jsonPath = jsonArg !== -1 ? process.argv[jsonArg + 1] : undefined;

function parsePackages(raw) {
  if (!raw) throw new Error('export-size: EXPORT_SIZE_PACKAGES is required (one `name:dir` per line).');
  return raw
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const index = entry.indexOf(':');
      return index === -1
        ? { dir: entry }
        : { name: entry.slice(0, index).trim(), dir: entry.slice(index + 1).trim() };
    });
}

const packages = parsePackages(process.env.EXPORT_SIZE_PACKAGES);

function brotliSize(contents) {
  return brotliCompressSync(contents, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
}

// Bundle with esbuild and measure the code that loads eagerly with the entry:
// the entry chunk plus every chunk it reaches through static imports. Chunks
// only reachable through dynamic `import()` load on demand and do not count
// toward an export's size.
async function sizeOf(options) {
  const result = await build({
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'neutral',
    // Split on dynamic-import boundaries so on-demand code lands in its own
    // chunks instead of being inlined into the measured entry.
    splitting: true,
    outdir: 'export-size-out',
    metafile: true,
    // Leave every bare import (peers, third-party) external so the measurement
    // reflects the package's own shipped code, not its dependencies.
    packages: 'external',
    write: false,
    logLevel: 'silent',
    ...options,
  });

  const { outputs } = result.metafile;
  // Every split chunk carries an `entryPoint` in the metafile, so seed the walk
  // from the requested entry only: the file passed as entry point, or `<stdin>`.
  const requested = options.entryPoints?.[0];
  const expected = requested
    ? relative(process.cwd(), requested).replaceAll('\\', '/')
    : '<stdin>';
  const eager = new Set();
  const queue = Object.keys(outputs).filter((path) => outputs[path].entryPoint === expected);
  while (queue.length > 0) {
    const path = queue.pop();
    if (eager.has(path)) continue;
    eager.add(path);
    for (const imported of outputs[path].imports) {
      if (!imported.external && imported.kind !== 'dynamic-import') queue.push(imported.path);
    }
  }

  // Metafile keys are cwd-relative POSIX paths; output file paths are absolute.
  const files = result.outputFiles.filter((file) =>
    eager.has(relative(process.cwd(), file.path).replaceAll('\\', '/')),
  );
  if (files.length === 0) {
    throw new Error('export-size: no output file matched the entry point.');
  }
  const contents = Buffer.concat(files.map((file) => file.contents));
  return { raw: contents.length, gzip: gzipSync(contents).length, brotli: brotliSize(contents) };
}

// The value exports of a built barrel, via esbuild's metafile (type-only exports
// are erased in the emitted JavaScript and carry no size, so they are excluded).
async function barrelExports(entry) {
  const { metafile } = await build({
    entryPoints: [entry],
    bundle: true,
    metafile: true,
    write: false,
    format: 'esm',
    packages: 'external',
    logLevel: 'silent',
  });
  const output = Object.values(metafile.outputs).find((out) => out.entryPoint);
  return (output?.exports ?? []).filter((exported) => exported !== 'default').sort();
}

// A package's explicit (non-pattern) subpath exports and the built entry each
// resolves to.
function publicSubpaths(exports, manifestDir) {
  return Object.entries(exports)
    .filter(([key]) => key === '.' || (key.startsWith('./') && !key.includes('*') && key !== './package.json'))
    .filter(([, value]) => value && typeof value === 'object' && 'import' in value)
    .map(([subpath, value]) => ({ subpath, entry: resolve(manifestDir, value.import) }));
}

function loadManifest(pkgDir) {
  // A generated `dist/package.json` (older publish layouts) is preferred so the
  // measured surface stays stable across layouts; entries resolve relative to it.
  const distManifest = resolve(pkgDir, 'dist/package.json');
  const manifestPath = existsSync(distManifest) ? distManifest : resolve(pkgDir, 'package.json');
  return { manifest: JSON.parse(readFileSync(manifestPath, 'utf8')), manifestDir: dirname(manifestPath) };
}

async function measure(pkg) {
  const pkgDir = resolve(root, pkg.dir);
  if (!existsSync(pkgDir)) return null;
  const { manifest, manifestDir } = loadManifest(pkgDir);
  const name = pkg.name ?? manifest.name ?? pkg.dir;
  const exports = manifest.exports ?? {};

  // One row per unique export name; a name seen again (e.g. a barrel export that
  // also has its own subpath) is skipped since it is the same code, same size.
  const byName = new Map();
  const record = async (exportName, options) => {
    if (!byName.has(exportName)) byName.set(exportName, { subpath: exportName, ...(await sizeOf(options)) });
  };

  if (mode === 'named-exports') {
    const barrelEntry = resolve(manifestDir, exports['.']?.import ?? exports['.']);
    const resolveDir = dirname(barrelEntry);
    const names = await barrelExports(barrelEntry);
    await record('.', { entryPoints: [barrelEntry] });
    for (const exportName of names) {
      await record(exportName, {
        stdin: { contents: `export { ${exportName} } from ${JSON.stringify(barrelEntry)}`, resolveDir, loader: 'js' },
      });
    }
    // Explicit subpaths that are not barrel exports (side-effect and non-barrel
    // entries such as `autoload` and `manifest`), measured from their own entry.
    for (const { subpath, entry } of publicSubpaths(exports, manifestDir)) {
      const key = subpath === '.' ? '.' : subpath.replace(/^\.\//, '');
      if (byName.has(key)) continue;
      await record(key, { entryPoints: [entry] });
    }
  } else {
    for (const { subpath, entry } of publicSubpaths(exports, manifestDir)) {
      await record(subpath, { entryPoints: [entry] });
    }
  }

  const entries = [...byName.values()].sort((a, b) => b.gzip - a.gzip);
  return { name, entries };
}

function kib(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${parseFloat((bytes / 1024).toFixed(2))} kB`;
}

const report = [];
for (const pkg of packages) {
  const measured = await measure(pkg);
  if (measured) report.push(measured);
}

const lines = [];
for (const { name, entries } of report) {
  lines.push(`\n### ${name}\n`);
  lines.push('| Export | Min | Min + Gzip | Min + Brotli |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const entry of entries) {
    lines.push(`| \`${entry.subpath}\` | ${kib(entry.raw)} | ${kib(entry.gzip)} | ${kib(entry.brotli)} |`);
  }
}
const markdown = lines.join('\n');

console.log(markdown);

if (jsonPath) {
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Export size\n${markdown}\n`, { flag: 'a' });
}
