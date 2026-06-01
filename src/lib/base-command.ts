import { Command, Flags } from '@oclif/core';
import { setupOclifContext } from '@lib/logging.ts';
import { closeScanDatabase, type DatabaseConnection } from '@lib/database.ts';
import type { JobContext } from '@lib/job-context.ts';
import { JobReporter } from '@lib/job-reporter.ts';

function makeBasicContext(
  database: DatabaseConnection,
  runId: string,
  rootPath: string
): JobContext {
  return {
    database,
    runId,
    rootPath,
    jobId: '',
    signal: new AbortController().signal,
  };
}

/**
 * Base class for all Archifiltre pipeline commands.
 *
 * Handles: --job-id flag, JobReporter lifecycle, logging context setup,
 * database close-on-exit, and error-to-job:error mapping.
 *
 * Subclasses implement:
 *   - jobType / jobLabel / phases — metadata emitted in job:start
 *   - openDatabase()             — opens (or creates) the scan database
 *   - runJob(context)            — the actual pipeline work
 */
export abstract class BaseCommand extends Command {
  static override baseFlags = {
    'job-id': Flags.string({
      description: 'Job identifier for structured JSON progress output',
    }),
  };

  abstract get jobType(): string;
  abstract get jobLabel(): string;
  abstract get phases(): string[];

  /**
   * Open (or create) the scan database and return the context seed values.
   * Called by the base run() before runJob. The base class closes the database afterward.
   */
  abstract openDatabase(): Promise<{ db: DatabaseConnection; runId: string; rootPath: string }>;

  /**
   * Perform the pipeline work. `context` carries database, runId, rootPath,
   * and (when --job-id is provided) onProgress / pauseSignal / resumeSignal / signal.
   */
  abstract runJob(context: JobContext): Promise<void>;

  override async run(): Promise<void> {
    const cleanupLogging = setupOclifContext(
      this as unknown as Parameters<typeof setupOclifContext>[0]
    );

    // Parse using the actual subclass so oclif accepts all its flags; we only use job-id here.
    const { flags } = await this.parse(this.constructor as typeof BaseCommand);
    const jobId = flags['job-id'];
    const reporter = jobId ? new JobReporter(jobId) : null;

    let db: DatabaseConnection | undefined;

    try {
      // openDatabase first so subclass can set dynamic jobLabel before job:start emits
      const { db: database, runId, rootPath } = await this.openDatabase();
      db = database;

      reporter?.start(this.jobType, this.jobLabel, this.phases);

      const context: JobContext = reporter
        ? reporter.createContext(database, runId, rootPath)
        : makeBasicContext(database, runId, rootPath);

      await this.runJob(context);

      reporter?.complete();
    } catch (err) {
      reporter?.error(err);
      throw err;
    } finally {
      if (db) await closeScanDatabase(db).catch(() => {});
      cleanupLogging();
    }
  }
}
