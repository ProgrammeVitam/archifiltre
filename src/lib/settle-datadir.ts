/**
 * settleDatadir — force a scan's PGlite datadir to durable storage at a safe boundary.
 *
 * PGlite runs on Emscripten NODEFS, whose `fsync` is a no-op: Postgres thinks it has
 * flushed the WAL, but the bytes may still be in the OS page cache. Process death is
 * safe (the page cache outlives the process), but a power cut can corrupt the datadir.
 *
 * We can't make every write durable without crippling throughput, but we CAN sync at the
 * moments that matter — scan completion and pause — so a *settled* scan always survives a
 * power loss. A mid-scan power cut then only ever costs an in-progress scan (which the
 * frontier + reconciliation handle gracefully), never a finished one.
 *
 * `sync -f <path>` flushes the filesystem containing the datadir (Linux/macOS). Windows
 * has no equivalent CLI; there we rely on the app-close flush and leave a mid-run power
 * cut as a documented gap (reconciliation still surfaces it cleanly).
 */

import type { DatabaseConnection } from '@lib/database.ts';
import { getDatabasePath } from '@lib/platform-paths.ts';
import { logger } from '@lib/logging.ts';

export async function settleDatadir(connection: DatabaseConnection | undefined): Promise<void> {
  if (!connection) return;
  const dir = getDatabasePath(connection.name);
  try {
    if (process.platform === 'win32') {
      // No portable `sync -f`; the page cache still protects against process death, and
      // reconciliation handles the residual power-cut case. Documented gap.
      return;
    }
    // `sync -f FILE` (coreutils / BSD) syncs the filesystem holding FILE — cheap and
    // scoped, unlike a global `sync`.
    const proc = Bun.spawn(['sync', '-f', dir], { stdout: 'ignore', stderr: 'ignore' });
    await proc.exited;
  } catch (error) {
    logger.debug('settleDatadir sync failed (non-fatal)', {
      db: connection.name,
      error: (error as Error).message,
    });
  }
}
