# tris-build

Builds the web export of a Godot project. This is the build step of Tris (https://creds.club),
kept in its own public repository so that any repository, private ones included, can call it.

## From GitHub Actions

```yaml
jobs:
  build:
    uses: polats/tris-build/.github/workflows/build.yml@main
```

Inputs, all optional: `project-path` (directory holding `project.godot`), `preset` (export preset
name) and `godot-version` (exact version such as `4.7.2`).

## By hand

```bash
./tris-build.sh <repo-dir> <out-dir>
```

Needs `bash`, `git`, `curl` and `unzip` on Linux x86_64. The engine and its web templates are
downloaded from [godotengine/godot-builds](https://github.com/godotengine/godot-builds) and cached
in `~/.cache/tris`.

## What it does

1. Finds `project.godot` (the shallowest one) and reads the Godot version from `config/features`.
   Only major.minor is recorded there, so the latest stable patch is used.
2. Uses the first export preset whose platform is Web. `export_presets.cfg` is often gitignored;
   when there is no Web preset a default single-threaded one is added for the build.
3. Imports, then exports. A fresh checkout has no `.godot/` folder and an export without an import
   pass fails on unimported resources.
4. Runs `.tris/after-export <out-dir>` from the project directory if the repository has one, for
   files the export does not produce: a manifest, fonts, extra packs.
5. Writes `tris-build.json` beside the build: Godot version, preset, size, timings, and whether the
   build needs cross-origin isolation headers (threads or GDExtension).

## Supported projects

Godot 4.3 and later, GDScript. C# projects have no web export in Godot 4. Godot 4.0–4.2 need
hosting headers for every web build and are refused.
