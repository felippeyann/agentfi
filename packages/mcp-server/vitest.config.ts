import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Fixed test values: api-client.ts reads these at import time and the
    // error sanitizer must strip both from anything it returns.
    env: {
      AGENTFI_API_URL: 'http://agentfi-backend.test-net:3000',
      AGENTFI_API_KEY: 'agfi_live_00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    },
  },
});
