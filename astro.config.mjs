import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import backendBootstrap from './src/integrations/backend-bootstrap';

// Node server output: the terminal needs backend API routes plus a background
// scheduler daemon (CFTC / Yahoo scrapes + UTC cron jobs), so the site can no
// longer be a pure static bundle.
export default defineConfig({
  site: 'https://trading-llc.example.com',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [backendBootstrap()],
});
