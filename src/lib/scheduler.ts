/**
 * Background scheduler daemon for the macro/COT hub.
 *
 * Starts exactly once per server process (singleton guard on globalThis):
 *  - three UTC cron jobs (CFTC Friday release watcher, daily integrity sync,
 *    hourly futures volume/OI sync)
 *  - the on-boot bootstrap scrape (cache empty or stale -> immediate sync)
 *
 * The watcher polls cftc.gov every 5 minutes inside the Friday 19:00-22:00 UTC
 * release window and stops as soon as the new weekly report date is ingested.
 */
import cron from 'node-cron';
import { CRON_JOBS, readStatus, runBootstrap, syncCOT, syncVolumeOi, withStatus } from './pipeline';
import { fetchLegacyLatest } from './cftc';
import { INSTRUMENTS } from './instruments';

declare global {
  // eslint-disable-next-line no-var
  var __termSchedulerStarted: boolean | undefined;
}

const CODES = new Set(INSTRUMENTS.map((i) => i.cftcContractCode));

/** ISO date (UTC) of the most recent Friday on/before the given instant. */
function thisWeekFridayIso(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun … 5=Fri
  const diff = (5 - day + 7) % 7;
  const fri = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff),
  );
  return fri.toISOString().slice(0, 10);
}

let releaseWatchDoneFor: string | null = null;

/** Friday release watcher: ingest the new weekly report the moment it lands. */
async function cftcReleaseWatcher(): Promise<void> {
  const fridayIso = thisWeekFridayIso();
  if (releaseWatchDoneFor === fridayIso) return;
  try {
    const latest = await fetchLegacyLatest(CODES);
    let newest: string | null = null;
    for (const row of latest.values()) {
      if (!newest || row.date > newest) newest = row.date;
    }
    const status = await readStatus();
    if (newest && newest > (status.cftc.latestReportDate ?? '')) {
      console.log(`[cron] New CFTC report detected (${newest}) — running full sync.`);
      await syncCOT();
      releaseWatchDoneFor = fridayIso;
      console.log('[cron] Release watch complete for this week.');
    }
  } catch (e) {
    console.warn('[cron] cftc_release_watcher attempt failed:', String((e as Error)?.message ?? e));
  }
}

/** Daily integrity sync: full re-sync whenever the upstream report date changed. */
async function cftcDailyIntegritySync(): Promise<void> {
  try {
    const status = await readStatus();
    const latest = await fetchLegacyLatest(CODES);
    let newest: string | null = null;
    for (const row of latest.values()) {
      if (!newest || row.date > newest) newest = row.date;
    }
    if (newest && newest !== (status.cftc.latestReportDate ?? '')) {
      console.log(`[cron] Daily integrity sync — report date changed (${newest}); re-syncing.`);
      await syncCOT();
    } else {
      await withStatus((st) => { st.cftc.lastVerifiedAt = new Date().toISOString(); });
      console.log('[cron] Daily integrity sync — report date unchanged; cache verified.');
    }
  } catch (e) {
    console.warn('[cron] cftc_daily_integrity_sync failed:', String((e as Error)?.message ?? e));
  }
}

/** Hourly futures volume/OI sync (weekdays). */
async function futuresVolumeOiSync(): Promise<void> {
  try {
    await syncVolumeOi();
  } catch (e) {
    console.warn('[cron] futures_volume_oi_sync failed:', String((e as Error)?.message ?? e));
  }
}

export function ensureScheduler(): void {
  if (globalThis.__termSchedulerStarted) return;
  globalThis.__termSchedulerStarted = true;
  console.log('[scheduler] Starting background daemon (UTC cron jobs + bootstrap).');

  cron.schedule(CRON_JOBS[0].schedule, () => void cftcReleaseWatcher(), { timezone: 'UTC' });
  cron.schedule(CRON_JOBS[1].schedule, () => void cftcDailyIntegritySync(), { timezone: 'UTC' });
  cron.schedule(CRON_JOBS[2].schedule, () => void futuresVolumeOiSync(), { timezone: 'UTC' });

  void runBootstrap();
}
