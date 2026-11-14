/**
 * The base of every error yaah raises on purpose.
 *
 * `code` is stable and machine-readable; `message` may be localised. A caller that needs
 * to branch does so on `code` or on the subclass.
 *
 * This file imports nothing, so that code which must stay free of I/O — the core loop,
 * which is bundled as a Temporal workflow — can raise yaah errors.
 */
export class YaahError extends Error {
  /** A stable, dot-separated identifier such as `entity.not-found`. */
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.name = new.target.name;
  }
}
