# Fresh install test harness — test container image
#
# A pristine machine: node, bash, and the Claude Code CLI, and nothing else.
# The plugin source is copied in *without* its dependency trees or built
# dashboard (see .dockerignore), which is exactly the shape of a Claude plugin
# marketplace install. The collector has to make itself runnable from that.

FROM node:22-alpine

# Runtime dependencies:
# - bash: entrypoint script and the plugin's hooks (Alpine default is ash)
# - curl + jq: verification checks against the server API
RUN apk add --no-cache bash curl jq

# Install the latest Claude Code CLI globally. The CLAUDE_CODE_CACHE_BUST
# build arg is passed a fresh value on every test run so this layer is
# never cached — we want the harness to track what real users run
# (claude auto-updates for them, so tests pinned to an old cached
# version give false confidence).
ARG CLAUDE_CODE_CACHE_BUST=1
RUN echo "cache bust token: ${CLAUDE_CODE_CACHE_BUST}" && \
    npm install -g @anthropic-ai/claude-code@latest

# Copy plugin source into a known location. The .dockerignore at the repo
# root excludes node_modules, build artifacts, and VCS state — do not relax
# it, or the harness stops testing a fresh install. `node` is the image's
# built-in non-root user; the claude CLI refuses bypassPermissions as root.
COPY . /plugin
RUN chown -R node:node /plugin

# Entrypoint script — orchestrates the claude run, verification, and the
# diagnostic dump.
COPY test/fresh-install/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
