/**
 * Which tool model a run uses, answered in one place so `exec`, `auth status` and `serve` can
 * never disagree about it.
 *
 * Two models, two jobs. The BASELINE model (the registry's default, `OBREW_MODEL`, `--model`)
 * writes: prose, narration, the content of an answer. The TOOL model turns what it wrote into a
 * tool call or a schema'd answer (see ./structure.ts). The value is `needle3`, `none`, or the
 * path of a fine-tuned `.cact` to run with the installed runner:
 *
 *   `-c tool_model=`  →  `OBREW_TOOL_MODEL`  →  config.json `toolModel`  →  needle3
 *
 * Asking for a tool model that is not installed is not an error: the run is the same run it
 * was before the tool model existed, with the baseline model decoding under a grammar.
 */
import { loadConfig, type Config } from '../shared/config'
import { findNeedle, NEEDLE_ID, type NeedleInstall } from './install'

export interface ToolModelStatus {
  /** `needle3`, a `.cact` path, or `none`. What was asked for, installed or not. */
  id: string
  /** Asked for AND installed: a run will use it. */
  enabled: boolean
  installed: boolean
}

export interface ResolvedToolModel extends ToolModelStatus {
  /** Runner and weights to launch; null when not enabled. */
  install: NeedleInstall | null
}

const OFF = new Set(['none', 'off', 'false', '0'])

export async function resolveToolModel(override?: string, config?: Config): Promise<ResolvedToolModel> {
  const cfg = config ?? (await loadConfig())
  const asked = (override ?? process.env.OBREW_TOOL_MODEL ?? cfg.toolModel ?? NEEDLE_ID).trim() || NEEDLE_ID
  if (OFF.has(asked.toLowerCase())) return { id: 'none', enabled: false, installed: false, install: null }

  const found = await findNeedle()
  if (asked === NEEDLE_ID) {
    return { id: NEEDLE_ID, enabled: found !== null, installed: found !== null, install: found }
  }
  // A path: someone's fine-tune, run by the runner that is already installed.
  const weightsExist = await Bun.file(asked).exists()
  const install = found && weightsExist ? { ...found, weights: asked } : null
  return { id: asked, enabled: install !== null, installed: install !== null, install }
}

export async function toolModelStatus(config?: Config): Promise<ToolModelStatus> {
  const { id, enabled, installed } = await resolveToolModel(undefined, config)
  return { id, enabled, installed }
}
