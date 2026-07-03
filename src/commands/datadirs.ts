/**
 * datadirs command — list every scan datadir on disk with its durable meta.
 *
 * The desktop app calls this once at startup to reconcile the on-disk truth against its
 * localStorage scan list: it surfaces interrupted scans the UI forgot (crash before
 * persist, wiped webview profile) and datadirs that no longer match a known tab. Pure
 * filesystem read — no PGlite is opened, so it also works for a datadir that won't open.
 */

import { Command } from '@oclif/core';
import { listDatadirs } from '@lib/datadir-meta.ts';

export default class Datadirs extends Command {
  static override description = 'List scan datadirs and their durable status (JSON)';

  static override summary = 'Enumerate on-disk scan databases for startup reconciliation';

  static override examples = ['<%= config.bin %> <%= command.id %>'];

  public async run(): Promise<void> {
    const entries = await listDatadirs();
    this.log(JSON.stringify({ datadirs: entries }));
  }
}
