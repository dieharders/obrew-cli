/**
 * Whether image generation is set up, read from files alone (no process is spawned): what
 * `obrew auth status --json` reports as its `image` block and `obrew serve` as part of
 * `/obrew/status`. Never part of the text engine's `ready`.
 */
import { imageEngineStatus } from './engine/install'
import { findBundle, isComplete, loadImageRegistry, slotId } from './registry'

export interface ImageStatus {
  ready: boolean
  edit: boolean
  upscale: boolean
  engine: { installed: boolean; tag: string; variant: string | null }
  model: { default: string; chosen: string | null; installed: boolean; edit: string }
  setup: string
  /** Set when the image state could not be read (a malformed file); the text answer stands. */
  error?: string
}

export async function imageStatus(): Promise<ImageStatus> {
  const setup = 'obrew image setup'
  try {
    const engine = await imageEngineStatus()
    const registry = await loadImageRegistry()
    const installed = async (id: string) => {
      const bundle = findBundle(registry, id)
      return bundle ? isComplete(registry, bundle) : false
    }
    const generator = slotId(registry, 'generator')
    const editor = slotId(registry, 'edit')
    const [genOk, editOk, upOk] = await Promise.all([installed(generator), installed(editor), installed(slotId(registry, 'upscaler'))])
    return {
      ready: engine.installed && genOk,
      edit: engine.installed && editOk,
      upscale: engine.installed && upOk,
      engine: { installed: engine.installed, tag: engine.tag, variant: engine.variant },
      model: { default: generator, chosen: registry.default, installed: genOk, edit: editor },
      setup,
    }
  } catch (err) {
    return {
      ready: false,
      edit: false,
      upscale: false,
      engine: { installed: false, tag: '', variant: null },
      model: { default: '', chosen: null, installed: false, edit: '' },
      setup,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
