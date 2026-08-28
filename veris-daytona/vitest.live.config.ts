import { defineConfig } from 'vitest/config'

// Live tests hit real Daytona and real Veris. They need DAYTONA_API_KEY,
// VERIS_API_KEY and VERIS_ENVIRONMENT_ID, and they cost money.
export default defineConfig({
  test: { include: ['tests/live/**/*.test.ts'], environment: 'node', testTimeout: 900_000, hookTimeout: 900_000 },
})
