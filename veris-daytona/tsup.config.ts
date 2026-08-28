import { defineConfig } from 'tsup'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node20',
  external: ['@daytona/sdk'],
  define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
})
