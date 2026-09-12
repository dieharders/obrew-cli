/**
 * Make sure no child process outlives this one on a normal exit.
 *
 * Copied from motionbuff/packages/shell/src/proc.ts. Here the children are `llama-server`
 * instances and stdio MCP servers. Controllers are tracked rather than processes so this file
 * never needs to know how anything is spawned: aborting the controller is the owner's cue to
 * kill its child.
 *
 * A HARD kill of this process (TerminateProcess on Windows, SIGKILL elsewhere) runs none of
 * this. That case is covered separately by the orphan reaper in `engine/running.ts`, which the
 * next `obrew` invocation runs before starting anything.
 */
const live = new Set<AbortController>()

export function track(controller: AbortController): void {
  live.add(controller)
}

export function untrack(controller: AbortController): void {
  live.delete(controller)
}

/** Abort every in-flight child. Safe to call more than once. */
export function sweep(): void {
  for (const controller of live) {
    try {
      controller.abort()
    } catch {
      // Already aborted. Nothing to do.
    }
  }
  live.clear()
}

let hooked = false

export function hookShutdown(): void {
  if (hooked) return
  hooked = true
  // Handlers must be synchronous — `exit` does not await anything — which is why aborting
  // (synchronous) is the right lever here.
  process.once('exit', sweep)
  process.once('beforeExit', sweep)
}
