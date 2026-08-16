// errors.ts — what a run can go wrong with, and how it says so.
//
// The tool answers with three exit codes and nothing else: 0 when there is
// nothing to report, 1 when it found violations and listed them on the output
// sink, and 2 when it was misconfigured or misused. The distinction that
// matters is the last one: a violation is a fact about the tree, so it is
// reported and the run finishes; a configuration error means the run cannot
// know what the tree says, so it stops.

/** A misconfiguration or misuse: the run stops and writes nothing. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Where a command writes a line. Injected so a run needs no real streams. */
export type Sink = (line: string) => void;

/** The readable part of whatever was thrown, for a message that quotes it. */
export function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
