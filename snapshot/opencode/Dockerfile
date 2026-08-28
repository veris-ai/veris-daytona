# ghcr.io/veris-ai/veris-opencode
#
# The base image plus Node and OpenCode. This is what
# @veris-ai/daytona-opencode points its snapshot at; @veris-ai/daytona itself
# knows nothing about it and defaults to the toolchain-free base.
#
# The split matters: @veris-ai/daytona is the Veris integration for Daytona, the
# same way @veris-ai/e2b is for E2B. Running an agent in the sandbox is one use
# of it, not what it is.
#
# Baking OpenCode in also removes the 60-90s `npm i -g` that the E2B path pays
# on every sandbox — the main reason this layer exists at all rather than the
# plugin installing at runtime.
ARG VERIS_SANDBOX_VERSION=0.1.0
FROM ghcr.io/veris-ai/veris-sandbox:${VERIS_SANDBOX_VERSION}

ARG NODE_MAJOR=22
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

ARG OPENCODE_VERSION=latest
RUN npm install -g opencode-ai@${OPENCODE_VERSION} && npm cache clean --force

# The entrypoint, user, workdir and veris-proxy all come from the base and are
# deliberately not overridden here.
