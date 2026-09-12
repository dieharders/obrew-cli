/**
 * The default system prompt. A host normally supplies its own (`--system-prompt-file`), and
 * on resume the caller's prompt replaces whatever the transcript recorded.
 */
export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant running locally. Answer directly and concisely. ' +
  'When tools are available, use them for anything that needs facts from files or services rather than guessing.'
