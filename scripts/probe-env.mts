// Who is setting HTTP_PROXY inside the sandbox, and does the kernel redirect
// work once it is out of the way?
import { Daytona, Image, isVerisSandbox } from '@veris-ai/daytona'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOCKERFILE = join(HERE, '..', 'snapshot', 'base', 'Dockerfile')

const run = async (sbx: any, label: string, cmd: string) => {
  const r = await sbx.process.executeCommand(cmd, undefined, undefined, 60)
    .catch((e: unknown) => ({ exitCode: 1, result: String(e) }))
  console.log(`\n\x1b[1m${label}\x1b[0m\n${(r.result ?? '').trim()}`)
}

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
const sbx = await daytona.create({
  veris: { snapshot: 'veris-smoke-dev', snapshotImage: Image.fromDockerfile(DOCKERFILE) },
})
if (!isVerisSandbox(sbx)) throw new Error('no veris surface')
console.log(`sandbox ${sbx.id}  twin ${sbx.verisSandboxId}`)

try {
  await run(sbx, 'A. proxy vars actually in the env', 'env | grep -i proxy | sort')
  await run(sbx, 'A2. DOES veris-proxy handle CONNECT for a mapped host? (env bypassed)',
    `curl -sS --max-time 25 --proxy http://127.0.0.1:8080 https://api.stripe.com/v1/charges ` +
    `-o /dev/null -w 'HTTP %{http_code}' 2>&1 || true`)
  await run(sbx, 'A3. same, unmapped host through our proxy (strict must refuse)',
    `curl -sS --max-time 25 --proxy http://127.0.0.1:8080 https://example.com/ ` +
    `-o /dev/null -w 'HTTP %{http_code}' 2>&1 || true`)
  await run(sbx, 'C. curl WITH whatever env it inherits',
    `curl -sS --max-time 20 https://api.stripe.com/v1/charges -o /dev/null -w 'HTTP %{http_code}' 2>&1 || true`)
  await run(sbx, 'D. curl with proxy vars UNSET (forces the kernel redirect path)',
    `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy ` +
    `curl -sS --max-time 20 https://api.stripe.com/v1/charges -o /dev/null -w 'HTTP %{http_code}' 2>&1 || true`)
  await run(sbx, 'E. same, but to an UNMAPPED host — must still fail',
    `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy ` +
    `curl -sS --max-time 20 https://example.com/ -o /dev/null -w 'HTTP %{http_code}' 2>&1 || true`)

  const entry = await sbx.veris.receipt('stripe')
  console.log(`\n\x1b[1mRECEIPT\x1b[0m stripe saw ${entry.requests} request(s)`)
  for (const r of entry.entries.slice(0, 10)) console.log(`  ${r.method} ${r.path} -> ${r.status}`)
} finally {
  await sbx.delete().catch(() => {})
}
