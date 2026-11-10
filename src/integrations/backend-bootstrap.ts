/**
 * Astro integration: starts the background scheduler + bootstrap scrape the
 * moment the dev server boots (astro:server:setup). Production boots via
 * src/middleware.ts; the scheduler singleton prevents double starts.
 */
import type { AstroIntegration } from 'astro';
import { ensureScheduler } from '../lib/scheduler';

export default function backendBootstrap(): AstroIntegration {
  return {
    name: 'backend-bootstrap',
    hooks: {
      'astro:server:setup': () => {
        ensureScheduler();
      },
    },
  };
}
