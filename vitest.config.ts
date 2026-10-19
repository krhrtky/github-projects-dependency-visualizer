import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', environmentOptions: { jsdom: { url: 'https://github.com/orgs/acme/projects/1' } }, include: ['tests/**/*.test.ts'], restoreMocks: true } });
