#!/usr/bin/env bash
# Build the Web export of a Godot project. One recipe for the Actions workflow, a hosted builder
# and the agent box.
#
#   tris-build.sh <repo-dir> <out-dir>
#
# Environment:
#   TRIS_PROJECT_PATH   directory holding project.godot, relative to <repo-dir> (default: found)
#   TRIS_GODOT_VERSION  exact version such as 4.7.2 (default: latest stable patch of the minor
#                       the project names in config/features)
#   TRIS_PRESET         export preset name (default: the first preset whose platform is Web)
#   TRIS_CACHE          where engine downloads are kept (default: ~/.cache/tris)
#   TRIS_IMPORT_TIMEOUT / TRIS_EXPORT_TIMEOUT   seconds (default 1200 each)
#
# An executable .tris/after-export in the repository runs after the export, from the project
# directory, with <out-dir> as its only argument.
#
# Exit codes: 0 built, 2 the project cannot be built for web (message says why), 1 anything else.
set -euo pipefail

say() { printf 'tris: %s\n' "$*" >&2; }
unsupported() { say "unsupported: $*"; exit 2; }
fail() { say "error: $*"; exit 1; }

[ $# -eq 2 ] || fail "usage: tris-build.sh <repo-dir> <out-dir>"
repo=$(readlink -f "$1")
mkdir -p "$2"
out=$(readlink -f "$2")
cache=${TRIS_CACHE:-$HOME/.cache/tris}
builds=https://github.com/godotengine/godot-builds

# --- find the project -------------------------------------------------------------------------
if [ -n "${TRIS_PROJECT_PATH:-}" ]; then
  project="$repo/$TRIS_PROJECT_PATH"
else
  # The shallowest project.godot wins; addons and test fixtures sit deeper.
  found=$(find "$repo" -name project.godot -not -path '*/.git/*' -printf '%d %h\n' | sort -n | head -1 | cut -d' ' -f2-)
  [ -n "$found" ] || unsupported "no project.godot in this repository"
  project=$found
fi
[ -f "$project/project.godot" ] || unsupported "no project.godot at ${TRIS_PROJECT_PATH:-.}"
[ "$project" = "$repo" ] && say "project: ." || say "project: ${project#"$repo"/}"

# --- which Godot ------------------------------------------------------------------------------
features=$(grep -m1 '^config/features=' "$project/project.godot" || true)
if grep -q '"C#"' <<<"$features" || compgen -G "$project/*.csproj" >/dev/null; then
  unsupported "C# projects cannot be exported to the web in Godot 4"
fi

if [ -n "${TRIS_GODOT_VERSION:-}" ]; then
  version=$TRIS_GODOT_VERSION
else
  minor=$(grep -oE '"[0-9]+\.[0-9]+"' <<<"$features" | head -1 | tr -d '"')
  [ -n "$minor" ] || unsupported "project.godot names no Godot version (Godot 3 projects are not supported)"
  major=${minor%%.*}
  [ "$major" -eq 4 ] && [ "${minor#*.}" -ge 3 ] ||
    unsupported "Godot $minor: the web export needs 4.3 or later to run without special hosting headers"
  # godot-builds tags stable releases as 4.7-stable, 4.7.1-stable, ...
  version=$(git ls-remote --tags "$builds" "refs/tags/$minor-stable" "refs/tags/$minor.*-stable" |
    sed -E 's|.*refs/tags/(.*)-stable$|\1|' | sort -V | tail -1)
  [ -n "$version" ] || unsupported "Godot $minor has no stable release"
fi
say "godot: $version"

# --- engine and web templates, cached per version ---------------------------------------------
engine="$cache/godot/$version"
godot="$engine/godot"
templates="$engine/templates"
if [ ! -x "$godot" ] || [ ! -f "$templates/version.txt" ]; then
  say "downloading Godot $version"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  base="$builds/releases/download/$version-stable/Godot_v$version-stable"
  curl -fsSL --retry 3 -o "$tmp/editor.zip" "${base}_linux.x86_64.zip"
  curl -fsSL --retry 3 -o "$tmp/templates.tpz" "${base}_export_templates.tpz"
  mkdir -p "$engine" "$templates"
  unzip -q -o "$tmp/editor.zip" -d "$tmp/editor"
  mv "$tmp/editor/Godot_v$version-stable_linux.x86_64" "$godot"
  chmod +x "$godot"
  # The archive carries every platform; only the web templates are kept.
  unzip -q -o -j "$tmp/templates.tpz" 'templates/web_*' 'templates/version.txt' -d "$templates"
  rm -rf "$tmp"
  trap - EXIT
fi
# Godot looks templates up by "<version>.stable" under its data directory.
data="${XDG_DATA_HOME:-$HOME/.local/share}/godot/export_templates"
mkdir -p "$data"
ln -sfn "$templates" "$data/$version.stable"

# --- the Web preset ---------------------------------------------------------------------------
presets="$project/export_presets.cfg"
web_preset() {
  [ -f "$presets" ] || return 0
  awk '
    /^\[preset\.[0-9]+\]$/ { name = ""; in_head = 1; next }
    /^\[/ { in_head = 0 }
    in_head && /^name=/ { name = $0; sub(/^name="/, "", name); sub(/"$/, "", name) }
    in_head && /^platform="Web"$/ { print name; exit }
  ' "$presets"
}
preset=${TRIS_PRESET:-$(web_preset)}
injected=false
if [ -z "$preset" ]; then
  # export_presets.cfg is commonly gitignored. Options left out take the engine defaults.
  n=$(grep -cE '^\[preset\.[0-9]+\]$' "$presets" 2>/dev/null || true)
  preset=Web
  injected=true
  cat >>"$presets" <<EOF

[preset.${n:-0}]

name="Web"
platform="Web"
runnable=true
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter=""
export_path=""

[preset.${n:-0}.options]

variant/extensions_support=false
variant/thread_support=false
vram_texture_compression/for_desktop=true
vram_texture_compression/for_mobile=false
progressive_web_app/enabled=false
EOF
  say "no Web preset in the repository; using a default one"
fi
say "preset: $preset"

# Threaded and GDExtension builds need cross-origin isolation headers from the host.
isolation=false
if awk -v want="$preset" '
    /^\[preset\.[0-9]+\]$/ { id = $0; sub(/\]$/, "", id); next }
    /^name=/ { n = $0; sub(/^name="/, "", n); sub(/"$/, "", n); if (n == want) target = id ".options]" }
    $0 == target { on = 1; next }
    /^\[/ { on = 0 }
    on && /^variant\/(thread|extensions)_support=true$/ { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$presets"; then
  isolation=true
fi

# --- import, then export ----------------------------------------------------------------------
# .godot/ is gitignored, so a fresh checkout has no imported resources and an export without an
# import pass fails on them. Godot can hang headless; every call gets a timeout.
started=$(date +%s)
say "importing"
timeout "${TRIS_IMPORT_TIMEOUT:-1200}" "$godot" --headless --path "$project" --import >"$out/../tris-import.log" 2>&1 ||
  { tail -40 "$out/../tris-import.log" >&2; fail "import failed or timed out (log above)"; }
imported=$(date +%s)

say "exporting"
timeout "${TRIS_EXPORT_TIMEOUT:-1200}" "$godot" --headless --path "$project" --export-release "$preset" "$out/index.html" \
  >"$out/../tris-export.log" 2>&1 ||
  { tail -40 "$out/../tris-export.log" >&2; fail "export failed or timed out (log above)"; }
finished=$(date +%s)

# Godot exits 0 on some failed exports, so the files are the proof.
for f in index.html index.wasm index.pck; do
  [ -s "$out/$f" ] || { tail -40 "$out/../tris-export.log" >&2; fail "export produced no $f (log above)"; }
done

# A repository can finish its own build: files the export does not produce (a manifest, fonts,
# extra packs). Runs from the project directory with the output directory as its argument.
hook="$repo/.tris/after-export"
if [ -x "$hook" ]; then
  say "running .tris/after-export"
  (cd "$project" && "$hook" "$out") || fail ".tris/after-export failed"
fi

bytes=$(du -sb "$out" | cut -f1)
cat >"$out/tris-build.json" <<EOF
{
  "godot": "$version",
  "preset": "$preset",
  "presetInjected": $injected,
  "crossOriginIsolation": $isolation,
  "bytes": $bytes,
  "importSeconds": $((imported - started)),
  "exportSeconds": $((finished - imported))
}
EOF
say "built $((bytes / 1048576)) MiB in $((finished - started))s"
