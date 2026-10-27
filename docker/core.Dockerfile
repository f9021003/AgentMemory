# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────
# memory-core (Rust) — production image with LLM CLIs pre-installed
#
#   docker build -f docker/core.Dockerfile -t memory-core:local .
#   docker run --rm -p 8420:8420 \
#     -e AGENT_MEMORY_API_KEY=change-me \
#     -e AGENT_MEMORY_LLM_PROVIDER=cli -e AGENT_MEMORY_LLM_CLI_COMMAND=claude \
#     -e AGENT_MEMORY_LLM_CLI_ARGS=-p -e ANTHROPIC_API_KEY=sk-ant-... \
#     -v memory-core-data:/data memory-core:local
#
# Bundled CLIs (official native installers, no npm; all verify checksums):
#   claude   Claude Code      https://claude.ai/install.sh
#   agy      Antigravity CLI  https://antigravity.google/cli/install.sh
#   codex    Codex CLI        https://chatgpt.com/codex/install.sh
#   opencode OpenCode CLI     https://opencode.ai/install
# Skip any with --build-arg INSTALL_CLAUDE=false / INSTALL_ANTIGRAVITY=false /
# INSTALL_CODEX=false / INSTALL_OPENCODE=false.
# ──────────────────────────────────────────────────────────────────────

FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
# Cache the registry and target dir across builds (BuildKit).
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p memory-server \
 && cp target/release/memory-server /usr/local/bin/memory-server

FROM debian:bookworm-slim AS runtime
# curl downloads the CLI installers; git is used by coding CLIs inside a project.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --home-dir /home/memory --uid 10001 --shell /bin/bash memory \
 && mkdir -p /data /config /workspace \
 && chown memory:memory /data /workspace

# The CLIs install into the user's home (~/.local/bin, or ~/.opencode/bin for
# opencode) and refuse to run as root, so install as the service user. The
# home directory is kept separate from the /data volume so a mounted volume
# never hides them.
USER memory
ENV PATH="/home/memory/.local/bin:/home/memory/.opencode/bin:${PATH}"
ARG INSTALL_CLAUDE=true
ARG CLAUDE_VERSION=stable
ARG INSTALL_ANTIGRAVITY=true
ARG INSTALL_CODEX=true
ARG INSTALL_OPENCODE=true
ARG OPENCODE_VERSION=latest
RUN set -eu; \
    if [ "$INSTALL_CLAUDE" = "true" ]; then \
      curl -fsSL https://claude.ai/install.sh -o /tmp/install-claude.sh; \
      bash /tmp/install-claude.sh "$CLAUDE_VERSION"; \
      rm /tmp/install-claude.sh; \
      claude --version; \
    fi; \
    if [ "$INSTALL_ANTIGRAVITY" = "true" ]; then \
      curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/install-agy.sh; \
      bash /tmp/install-agy.sh; \
      rm /tmp/install-agy.sh; \
      test -x /home/memory/.local/bin/agy; \
    fi; \
    if [ "$INSTALL_CODEX" = "true" ]; then \
      curl -fsSL https://chatgpt.com/codex/install.sh -o /tmp/install-codex.sh; \
      # The binary goes under CODEX_HOME; keep it out of ~/.codex, where the \
      # login volume is mounted and would hide it. \
      CODEX_HOME=/home/memory/.codex-cli sh /tmp/install-codex.sh; \
      rm /tmp/install-codex.sh; \
      codex --version; \
    fi; \
    if [ "$INSTALL_OPENCODE" = "true" ]; then \
      curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh; \
      if [ "$OPENCODE_VERSION" = "latest" ]; then \
        bash /tmp/install-opencode.sh --no-modify-path; \
      else \
        bash /tmp/install-opencode.sh --no-modify-path --version "$OPENCODE_VERSION"; \
      fi; \
      rm /tmp/install-opencode.sh; \
      opencode --version; \
    fi; \
    # Pre-create the login/data directories so volumes mounted there stay \
    # owned by the service user (Docker would create them as root). OpenCode \
    # keeps auth and session history under ~/.local/share/opencode. \
    mkdir -p /home/memory/.claude /home/memory/.gemini /home/memory/.codex \
      /home/memory/.local/share/opencode /home/memory/.config/opencode

# Global OpenCode config: a tool-less `distill` agent used for memory
# distillation. Every built-in tool is removed from the agent so `opencode
# run` stays a single text turn: it can neither modify the project at
# /workspace nor get derailed by the `skill` tool when a prompt happens to
# contain a skill-like phrase (e.g. L1's "scene-segmentation … expert").
# The CLI is always invoked with --pure, which stops config plugins (e.g. an
# AgentMemory capture plugin) from firing on the distillation prompts.
RUN printf '%s\n' \
    '{' \
    '  "$schema": "https://opencode.ai/config.json",' \
    '  "agent": {' \
    '    "distill": {' \
    '      "description": "Text-only agent for AgentMemory distillation",' \
    '      "mode": "primary",' \
    '      "tools": {' \
    '        "shell": false,' \
    '        "read": false,' \
    '        "glob": false,' \
    '        "grep": false,' \
    '        "edit": false,' \
    '        "write": false,' \
    '        "patch": false,' \
    '        "task": false,' \
    '        "fetch": false,' \
    '        "search": false,' \
    '        "todo": false,' \
    '        "skill": false,' \
    '        "question": false,' \
    '        "lsp": false,' \
    '        "plan": false,' \
    '        "execute": false' \
    '      },' \
    '      "permission": {' \
    '        "edit": "deny",' \
    '        "shell": "deny",' \
    '        "webfetch": "deny",' \
    '        "task": "deny",' \
    '        "question": "deny"' \
    '      }' \
    '    }' \
    '  }' \
    '}' \
    > /home/memory/.config/opencode/opencode.json

COPY --from=build /usr/local/bin/memory-server /usr/local/bin/memory-server
COPY config/memory-core.example.yaml /config/memory-core.yaml

ENV AGENT_MEMORY_CONFIG=/config/memory-core.yaml \
    AGENT_MEMORY_HOST=0.0.0.0 \
    AGENT_MEMORY_PORT=8420 \
    AGENT_MEMORY_DATA_DIR=/data \
    LOG_FORMAT=json
# Mount a project at /workspace and set AGENT_MEMORY_LLM_CLI_WORKDIR=/workspace
# to let the CLI see that project.
VOLUME ["/data"]
EXPOSE 8420
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["memory-server", "healthcheck"]
ENTRYPOINT ["memory-server"]
