# The Tris agent box: the Paseo daemon, the coding agents it drives, and headless Godot so an
# agent can import and check the project it is editing.
# The Paseo version is pinned: the dashboard bundles the SDK of the same version.
FROM ghcr.io/getpaseo/paseo:0.16.1

# Links the published image to this repository.
LABEL org.opencontainers.image.source="https://github.com/polats/tris-build"
LABEL org.opencontainers.image.description="The Tris agent box: Paseo daemon, coding agents and headless Godot"

USER root

# unzip and fontconfig are for Godot.
RUN apt-get update \
  && apt-get install -y --no-install-recommends unzip jq libfontconfig1 \
  && rm -rf /var/lib/apt/lists/*

# gh makes the Codespace's ports public at start. It has to be a current release: Debian's 2.23
# speaks the retired Live Share transport and hangs on `gh codespace ports`.
ARG GH_VERSION=2.105.0
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    | tar xz -C /tmp \
  && mv "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
  && rm -rf "/tmp/gh_${GH_VERSION}_linux_amd64"

RUN npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai \
  && npm cache clean --force

ARG GODOT_VERSION=4.7.2
RUN curl -fsSL -o /tmp/godot.zip \
    "https://github.com/godotengine/godot-builds/releases/download/${GODOT_VERSION}-stable/Godot_v${GODOT_VERSION}-stable_linux.x86_64.zip" \
  && unzip -q /tmp/godot.zip -d /tmp \
  && mv "/tmp/Godot_v${GODOT_VERSION}-stable_linux.x86_64" /usr/local/bin/godot \
  && chmod +x /usr/local/bin/godot \
  && rm /tmp/godot.zip

COPY tris-box-start /usr/local/bin/tris-box-start
COPY tris-pair-server.mjs /usr/local/lib/tris/tris-pair-server.mjs
RUN chmod +x /usr/local/bin/tris-box-start

USER paseo
