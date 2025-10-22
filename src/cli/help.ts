/**
 * Custom Oclif Help Class for Archifiltre
 *
 * Minimal implementation that only customizes header and footer
 * while letting Oclif handle all standard CLI behavior.
 */

import { Help, Command } from '@oclif/core';
import type { Config } from '@oclif/core';

export default class ArchifiltreHelp extends Help {
  constructor(config: Config) {
    super(config);
  }

  /**
   * Override root help - just replace header and add footer
   */
  formatRoot(): string {
    const defaultHelp = super.formatRoot();

    // Replace description and VERSION section with branded header
    const withBrandedHeader = defaultHelp.replace(
      /^[\s\S]*?\n\n[\s\S]*?VERSION[\s\S]*?\n\s+[\s\S]*?\n\n/,
      this.getBrandedHeader() + '\n\n'
    );

    return withBrandedHeader + '\n' + this.getFooter();
  }

  /**
   * Override command help - just add footer
   */
  formatCommand(command: Command.Loadable): string {
    const defaultHelp = super.formatCommand(command);
    return defaultHelp + '\n' + this.getFooter();
  }

  /**
   * Get branded header
   */
  private getBrandedHeader(): string {
    return 'Archifiltre v5\nPrivacy-friendly, 100% offline file tree inventory tool';
  }

  /**
   * Get footer with GitHub link
   */
  private getFooter(): string {
    return `For more information, visit: https://github.com/ProgrammeVitam/archifiltre`;
  }
}
