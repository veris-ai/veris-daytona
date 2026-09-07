import type { Sandbox } from '@daytona/sdk'
import { SnapshotUnsupportedError } from './errors'
import {
  CA_CERT_PATH,
  SYSTEM_BUNDLE,
  VERIS_BUNDLE,
  VERIS_CA_FILE,
} from './trust'

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** Rebuild from current sources, never from our previous generated bundle. */
export function caBundleScript(
  paths = {
    system: SYSTEM_BUNDLE,
    veris: VERIS_CA_FILE,
    installedVeris: CA_CERT_PATH,
    provider: '/etc/daytona/netleash/ca.crt',
    output: VERIS_BUNDLE,
  },
): string {
  return `(
set -eu
output=${quote(paths.output)}
veris=${quote(paths.veris)}
[ -s "$veris" ] || veris=${quote(paths.installedVeris)}
[ -s "$veris" ] || { echo 'Veris CA missing; recreate the sandbox' >&2; exit 1; }
tmp=$(mktemp "$output.tmp.XXXXXX")
raw=''
trap 'rm -f "$tmp" "$raw"' 0
raw=$(mktemp "$output.sources.XXXXXX")
{
  for ca in ${quote(paths.system)} ${quote(paths.provider)} "\${SSL_CERT_FILE:-}" "\${REQUESTS_CA_BUNDLE:-}" "\${CURL_CA_BUNDLE:-}" "\${NODE_EXTRA_CA_CERTS:-}" "$veris"; do
    [ "$ca" != "$output" ] || continue
    [ -f "$ca" ] || continue
    cat "$ca" || exit 1
    printf '\\n'
  done
} > "$raw"
awk '
/-----BEGIN CERTIFICATE-----/ { cert = ""; inside = 1 }
inside { cert = cert $0 "\\n" }
/-----END CERTIFICATE-----/ { if (inside && !seen[cert]++) printf "%s", cert; inside = 0 }
' "$raw" > "$tmp"
[ -s "$tmp" ] || { echo 'No CA certificates could be read' >&2; exit 1; }
chmod 0644 "$tmp"
if ! cmp -s "$tmp" "$output"; then mv -f "$tmp" "$output"; fi
echo __VERIS_CA_OK__
)`
}

/** One local trust refresh after lifecycle changes; no network canary. */
export async function refreshCaBundle(sandbox: Sandbox): Promise<void> {
  const result = await sandbox.process
    .executeCommand(
      `sh -c ${quote(caBundleScript())}`,
      undefined,
      undefined,
      60,
    )
    .catch(() => ({ exitCode: 1, result: '' }))
  if (result.exitCode !== 0 || !result.result.includes('__VERIS_CA_OK__')) {
    throw new SnapshotUnsupportedError(
      'could not refresh the Veris CA bundle; ensure the sandbox has its Veris CA and readable provider trust files',
      { phase: 'ca-install' },
    )
  }
}

/** Preserve lifecycle return values and only refresh after successful starts. */
export function refreshTrustAfterStart(sandbox: Sandbox): void {
  for (const name of ['start', 'recover'] as const) {
    const original = sandbox[name].bind(sandbox)
    sandbox[name] = async (...args: Parameters<typeof original>) => {
      const result = await original(...args)
      await refreshCaBundle(sandbox)
      return result
    }
  }
}
