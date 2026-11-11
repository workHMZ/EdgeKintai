import { readFileSync } from 'node:fs';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

interface WranglerTestBaseConfig {
  main: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  vars?: Record<string, string>;
}

function readWranglerTestBaseConfig(path: string): WranglerTestBaseConfig {
  const raw = readFileSync(path, 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(raw) as WranglerTestBaseConfig;
}

const wranglerConfig = readWranglerTestBaseConfig('./wrangler.jsonc');
const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Read wrangler.jsonc directly instead of `wrangler.configPath` so local
      // `.dev.vars` secrets are never loaded into hermetic test runs.
      main: `./${wranglerConfig.main.replace(/^\.\//, '')}`,
      miniflare: {
        compatibilityDate: wranglerConfig.compatibility_date,
        compatibilityFlags: wranglerConfig.compatibility_flags ?? [],
        d1Databases: ['DB', 'UPGRADE_DB'],
        ratelimits: {
          AUTH_RATE_LIMITER: {
            namespace_id: '2316401101',
            simple: { limit: 1_000, period: 60 },
          },
        },
        bindings: {
          ...wranglerConfig.vars,
          HEALTH_PROBE_ALLOWED_ORIGINS: 'https://status.example.test,https://dashboard.example.test',
          SETUP_TOKEN: 'test-setup-token-0123456789abcdef0123456789abcdef',
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
