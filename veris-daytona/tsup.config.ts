import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }

const shared = {
  dts: false,
  sourcemap: true,
  target: 'node20',
  external: ['@daytona/sdk'],
  define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
} as const

export default defineConfig([
  { ...shared, entry: ['src/index.ts'], format: ['esm', 'cjs'], clean: true },
  // The executable: ESM only, with the shebang npm's bin shim expects.
  { ...shared, entry: ['src/cli.ts'], format: ['esm'], banner: { js: '#!/usr/bin/env node' } },
])
