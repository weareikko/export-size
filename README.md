# Export size

A GitHub Action that measures the published export sizes of one or more npm
packages with [esbuild](https://esbuild.github.io/), diffs a pull request against
its base branch, and upserts a sticky comment listing every export whose size
changed.

Each export is bundled with peer and third-party dependencies left **external**
and the output **minified**, then reported raw, gzipped and brotli-compressed —
so the number reflects the package's own shipped code, not its dependencies.

## Usage

```yaml
name: export-size

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  export-size:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: weareikko/export-size@1
        with:
          packages: |
            @studiometa/ui:packages/ui
            @studiometa/ui-mapbox:packages/ui-mapbox
          build: npm run build
```

The action checks out the base branch itself, so it measures both sides with the
same logic — the base does not need the action installed.

## Inputs

| Input          | Default          | Description                                                                                             |
| -------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| `packages`     | —                | `name:dir` pairs, one per line or comma-separated. `dir` alone reads the name from its `package.json`.  |
| `build`        | —                | Command that builds the packages, run in each checkout before measuring.                                |
| `mode`         | `named-exports`  | `named-exports` sizes each barrel export (`import { X } from '<pkg>'`); `subpaths` sizes each subpath.   |
| `node-version` | `24`             | Node.js version.                                                                                        |
| `comment`      | `true`           | Upsert a sticky pull-request comment with the diff.                                                     |
| `github-token` | `${{ github.token }}` | Token used to upsert the comment (needs `pull-requests: write`).                                   |

## Modes

- **`named-exports`** — sizes each value export of the package barrel as a
  consumer imports it, by tree-shaking that single symbol out of the built
  barrel. A symbol reachable from several places (the barrel and its own subpath)
  is measured once. Best for tree-shakeable libraries with a barrel entry.
- **`subpaths`** — sizes each explicit subpath export from its own entry. Best
  when consumers import from subpaths rather than the barrel.

## Requirements

- The `build` command must produce the built entries the `exports` map points at
  (the action installs dependencies and runs it in each checkout).
- `permissions: pull-requests: write` for the comment.
- If your `.npmrc` sets `min-release-age`, a freshly published dependency can
  block `npm install`; exclude your own scope or relax it in CI.

## Local use

```sh
EXPORT_SIZE_PACKAGES='@studiometa/ui:packages/ui' node export-size.mjs
```

## License

MIT
