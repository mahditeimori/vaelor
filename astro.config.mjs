import { defineConfig } from 'astro/config';

// Static output: the site is hosted on Cloudflare Pages and all live data is
// served by the Cloudflare Worker (mcp/worker.js) over HTTPS.
export default defineConfig({
  site: 'https://vaelor.pages.dev',
  output: 'static',
});
