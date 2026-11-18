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

The job needs `permissions: id-token: write`. After the build, `tris-upload.mjs` publishes it to
Tris, authenticated by the job's own OIDC token; the repository has to be linked at
https://creds.club first.

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

## The agent box

`box/` is the image behind a game's agent chat on Tris: the [Paseo](https://github.com/getpaseo/paseo)
daemon, Codex, Claude Code and OpenCode, headless Godot, and a small server that lets the game's
owner in. It is published as `ghcr.io/polats/tris-box` by `.github/workflows/box.yml`.

A game repository uses it through `.devcontainer/devcontainer.json` (`box/devcontainer.json` is the
file Tris adds), and Tris runs it as a GitHub Codespace on that repository, in the owner's account.

- `tris-box-start` runs at every start: restores a saved Codex sign-in, installs the Godot version
  the project asks for when the image's differs, starts the daemon and the pair server, and makes
  their two ports public.
- `tris-pair-server.mjs` gives the daemon's password to a caller whose GitHub token belongs to the
  Codespace's owner. The daemon accepts browser connections from creds.club only.
