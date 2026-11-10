/**
 * JSON-cache storage layer for the macro/COT hub.
 * All scraped data lives under <project-root>/data/cache so no database
 * is required; writes are atomic (tmp file + rename).
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.env.TERMINAL_DATA_DIR
  ? path.resolve(process.env.TERMINAL_DATA_DIR)
  : process.cwd();

export const DATA_DIR = path.join(ROOT, 'data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const COT_DIR = path.join(CACHE_DIR, 'cot');
export const VOLUME_OI_DIR = path.join(CACHE_DIR, 'volume-oi');
export const META_DIR = path.join(CACHE_DIR, 'meta');

export const STATUS_FILE = path.join(META_DIR, 'sync-status.json');

export function cotFile(instrumentId: string): string {
  return path.join(COT_DIR, `${instrumentId}.json`);
}

export function volumeFile(instrumentId: string): string {
  return path.join(VOLUME_OI_DIR, `${instrumentId}.json`);
}

export async function ensureDirs(): Promise<void> {
  await Promise.all(
    [COT_DIR, VOLUME_OI_DIR, META_DIR].map((d) =>
      mkdir(d, { recursive: true }),
    ),
  );
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, file);
}

export function isoNow(): string {
  return new Date().toISOString();
}

/** Days elapsed since an ISO timestamp (null when the timestamp is missing). */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return (Date.now() - then) / 86_400_000;
}

/** Hours elapsed since an ISO timestamp (null when the timestamp is missing). */
export function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return (Date.now() - then) / 3_600_000;
}
