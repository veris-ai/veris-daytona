#!/bin/sh
# Bring veris-proxy up, then hand off.
#
# This runs when Daytona honours the snapshot's entrypoint. It may not — Daytona
# starts its own daemon inside the sandbox — which is exactly why
# @veris-ai/daytona does not TRUST this file: after create() it waits for
# /run/veris/ready and starts the proxy itself through a background session if
# the file never lands. Belt and braces, because a sandbox whose proxy is not up
# is a sandbox whose first vendor call reaches the real vendor.
set -eu

VERIS_RUN_DIR=/run/veris
READY_FILE="$VERIS_RUN_DIR/ready"
ENV_FILE="$VERIS_RUN_DIR/env"
CA_DIR="$VERIS_RUN_DIR/ca"
LOG="$VERIS_RUN_DIR/serve.log"
LISTEN=127.0.0.1:8080
PROXY_UID=14741

# /run is usually a tmpfs, so this is done here rather than baked into a layer.
#
# Ownership matters more than it looks. veris-proxy installs the kernel redirect
# as root and then drops to $PROXY_UID before publishing its trust material — so
# every path it writes AFTER that drop (the CA dir, the ready file, the env file)
# must already belong to that uid. Get this wrong and the proxy comes all the way
# up, logs "listening", and dies on the last write.
mkdir -p "$CA_DIR" 2>/dev/null || sudo -n mkdir -p "$CA_DIR" 2>/dev/null || true
chown -R "$PROXY_UID:$PROXY_UID" "$VERIS_RUN_DIR" 2>/dev/null \
  || sudo -n chown -R "$PROXY_UID:$PROXY_UID" "$VERIS_RUN_DIR" 2>/dev/null || true
# 755, not 700: the code under test reads the env file to find the CA.
chmod 755 "$VERIS_RUN_DIR" "$CA_DIR" 2>/dev/null || true

# No twin means this image is being run outside a Veris sandbox (a plain
# `docker run`, or a Daytona create that bypassed @veris-ai/daytona). Say so and
# carry on rather than failing the container: an un-intercepted sandbox is a
# real thing someone might want, and a silent proxy failure is what we refuse.
if [ -z "${VERIS_SANDBOX_ID:-}" ]; then
  echo "veris-entrypoint: VERIS_SANDBOX_ID is unset — starting WITHOUT interception." >&2
  echo "veris-entrypoint: create this sandbox through @veris-ai/daytona to get a twin." >&2
else
  # --transparent   the kernel redirect; covers runtimes that ignore HTTP_PROXY.
  #                 Needs root + NET_ADMIN; if the redirect cannot be installed
  #                 the proxy still serves on $LISTEN and the host-side
  #                 capability probe has already labelled this cooperative.
  # --strict        block unmapped hosts instead of letting them reach their
  #                 REAL destination. The difference between "nothing reached
  #                 the vendor" and "the hosts we mapped were intercepted".
  # --sandbox       attach to the twin the host provisioned. Never --environment.
  veris-proxy serve \
    --transparent \
    --strict \
    --sandbox "$VERIS_SANDBOX_ID" \
    --listen "$LISTEN" \
    --ca-dir "$CA_DIR" \
    --ready-file "$READY_FILE" \
    --write-env "$ENV_FILE" \
    --log-format json \
    >>"$LOG" 2>&1 &

  # Do not hand off until the listeners are bound, so nothing this container
  # runs can outrun interception.
  i=0
  while [ "$i" -lt 120 ]; do
    [ -f "$READY_FILE" ] && break
    i=$((i + 1))
    sleep 1
  done
  if [ ! -f "$READY_FILE" ]; then
    echo "veris-entrypoint: veris-proxy did not become ready in 120s; log tail:" >&2
    tail -40 "$LOG" >&2 2>/dev/null || true
  fi
fi

# Daytona supplies its own command; with none, idle so the sandbox stays up for
# the daemon and for `docker run` inspection.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
exec sleep infinity
