/** Reads the `yaah` command line. No effects: the result says what to do. */

/** What the command line asked for. */
export type Invocation =
  /** `yaah`: start a harness and open the terminal UI against it. */
  | { readonly command: 'chat'; readonly config: string | undefined }
  /** `yaah serve`: start a harness and serve the web UI until interrupted. */
  | { readonly command: 'serve'; readonly config: string | undefined }
  /**
   * `yaah tui --url <harness> [--attach]`: open the terminal UI against a running harness,
   * with `--attach` taking up the task that is already open there.
   */
  | { readonly command: 'tui'; readonly url: string; readonly attach: boolean }
  | { readonly command: 'help' }
  | { readonly command: 'version' }
  /** The command line was not understood; `problem` is a string key and its values. */
  | {
      readonly command: 'invalid';
      readonly problem: 'cli.error.unknown' | 'cli.error.value' | 'cli.error.url';
      readonly subject: string;
    };

const COMMANDS: ReadonlySet<string> = new Set(['serve', 'tui']);

interface Flags {
  config?: string;
  url?: string;
  help: boolean;
  attach: boolean;
  version: boolean;
  positional: string[];
  invalid?: Invocation;
}

function readFlags(argv: readonly string[]): Flags {
  const flags: Flags = { help: false, version: false, attach: false, positional: [] };
  for (let at = 0; at < argv.length; at += 1) {
    const [name = '', inline] = (argv[at] ?? '').split(/=(.*)/su, 2);
    if (name === '--help' || name === '-h') {
      flags.help = true;
    } else if (name === '--version' || name === '-v') {
      flags.version = true;
    } else if (name === '--attach') {
      flags.attach = true;
    } else if (name === '--config' || name === '--url') {
      const value = inline ?? argv[at + 1];
      at += inline === undefined ? 1 : 0;
      if (value === undefined || value === '') {
        flags.invalid ??= { command: 'invalid', problem: 'cli.error.value', subject: name };
      } else if (name === '--config') {
        flags.config = value;
      } else {
        flags.url = value;
      }
    } else if (name.startsWith('-')) {
      flags.invalid ??= { command: 'invalid', problem: 'cli.error.unknown', subject: name };
    } else {
      flags.positional.push(name);
    }
  }
  return flags;
}

/** Interprets the arguments after the program name. */
export function parseArgs(argv: readonly string[]): Invocation {
  const flags = readFlags(argv);
  if (flags.help) {
    return { command: 'help' };
  }
  if (flags.version) {
    return { command: 'version' };
  }
  if (flags.invalid !== undefined) {
    return flags.invalid;
  }
  const [command, extra] = flags.positional;
  const unknown = extra ?? (command !== undefined && !COMMANDS.has(command) ? command : undefined);
  if (unknown !== undefined) {
    return { command: 'invalid', problem: 'cli.error.unknown', subject: unknown };
  }
  if (command === 'tui') {
    if (flags.url === undefined || !URL.canParse(flags.url)) {
      return { command: 'invalid', problem: 'cli.error.url', subject: flags.url ?? '' };
    }
    return { command: 'tui', url: flags.url.replace(/\/$/u, ''), attach: flags.attach };
  }
  if (flags.url !== undefined || flags.attach) {
    const subject = flags.url === undefined ? '--attach' : '--url';
    return { command: 'invalid', problem: 'cli.error.unknown', subject };
  }
  return { command: command === 'serve' ? 'serve' : 'chat', config: flags.config };
}
