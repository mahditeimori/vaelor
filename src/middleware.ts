/**
 * Astro middleware: also boots the background scheduler when the Node server
 * starts in production (the middleware module is imported at server startup,
 * so its top level runs exactly once — the singleton guard makes this safe
 * even when it is reached from multiple entry points).
 */
import { defineMiddleware } from 'astro/middleware';
import { ensureScheduler } from './lib/scheduler';

ensureScheduler();

export const onRequest = defineMiddleware((_context, next) => next());
