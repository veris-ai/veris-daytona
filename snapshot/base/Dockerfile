# ghcr.io/veris-ai/veris-sandbox
#
# The generic Veris sandbox image: a Daytona sandbox that comes up with
# veris-proxy serving, so vendor API calls are answered by a Veris twin. It
# carries NO language toolchain and NO agent — whatever you run is yours to
# bring.
#
# @veris-ai/daytona registers a snapshot from this into the caller's Daytona
# organization on first use (see src/snapshot.ts for why a registry image rather
# than a published snapshot: snapshots carry an organizationId and cannot be
# shared across accounts).
#
# Build on it for a toolchain of your own — ../opencode/Dockerfile is exactly
# that, and is what @veris-ai/daytona-opencode uses:
#     FROM ghcr.io/veris-ai/veris-sandbox:0.1.0
#     RUN apt-get update && apt-get install -y python3 python3-pip
FROM debian:12-slim

# ---------------------------------------------------------------- base tooling
# ca-certificates is not optional: the proxy installs the Veris CA into the
# system store, and update-ca-certificates is what rebuilds the bundle.
# nftables/iptables carry the transparent tier's kernel redirect.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client sudo procps \
      nftables iptables libcap2-bin \
      unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------- veris-proxy
# A static binary, no root needed to install. Pinned by tag so the image is
# reproducible; the snapshot name in src/snapshot.ts carries the image version
# so a bump re-registers rather than mutating an existing snapshot.
ARG VERIS_PROXY_VERSION=v0.8.1
RUN curl -fsSL -o /usr/local/bin/veris-proxy \
      "https://github.com/veris-ai/veris-proxy/releases/download/${VERIS_PROXY_VERSION}/veris-proxy-linux-amd64" \
    && chmod 0755 /usr/local/bin/veris-proxy \
    && veris-proxy version

# ------------------------------------------------------------------- the user
# NOT uid 14741 — that is the uid the kernel redirect exempts for the proxy
# itself, and veris-proxy refuses to run if the code under test shares it.
# 1000 is conventional and safely clear of it.
RUN useradd -m -u 1000 -s /bin/bash daytona \
    && echo 'daytona ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/daytona \
    && chmod 0440 /etc/sudoers.d/daytona \
    && mkdir -p /home/daytona/project \
    && chown -R daytona:daytona /home/daytona

# The uid veris-proxy drops to after installing the redirect. It needs to exist
# with a home of its own: the proxy publishes trust material to $HOME/.veris
# AFTER dropping privileges, and /root is not writable by then.
RUN useradd -u 14741 -m -d /var/lib/veris -s /usr/sbin/nologin veris \
    && mkdir -p /run/veris/ca \
    && chown -R 14741:14741 /run/veris \
    && chmod 755 /run/veris /run/veris/ca

WORKDIR /home/daytona/project

# ------------------------------------------------------------------ entrypoint
# Kept in lockstep with SNAPSHOT_ENTRYPOINT in src/snapshot.ts, which is what
# Daytona actually registers — this ENTRYPOINT is the fallback for anyone
# running the image directly, and the snapshot's entrypoint field wins.
#
# --sandbox "$VERIS_SANDBOX_ID" attaches to the twin the HOST provisioned. Never
# --environment: a proxy that deploys its own twin never tells the host the id,
# leaving receipts unreadable and the twin un-deletable.
#
# --strict is load-bearing: without it, unmapped hosts reach the real internet.
COPY entrypoint.sh /usr/local/bin/veris-entrypoint
RUN chmod 0755 /usr/local/bin/veris-entrypoint

ENTRYPOINT ["/usr/local/bin/veris-entrypoint"]
