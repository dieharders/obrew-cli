/**
 * The argv prefix that runs an engine binary.
 *
 * A script named by `OBREW_LLAMA_SERVER` or `OBREW_SD_SERVER` runs under this same Bun (tests use
 * fake servers written in TypeScript). Only meaningful when running from source: in a compiled
 * binary `process.execPath` is obrew itself.
 */
export const engineCommand = (binary: string): string[] =>
  /\.[cm]?[jt]s$/.test(binary) ? [process.execPath, binary] : [binary]
