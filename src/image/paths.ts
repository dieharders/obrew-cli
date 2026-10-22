/**
 * Where image generation keeps its state: `<data>/image/`, apart from the text engine's.
 *
 * Apart on purpose. The text engine's `config.json` and `models.json` are zod objects that drop
 * keys they do not know every time they are re-saved, so an image setting stored there would
 * vanish on the next `obrew engine install`; and the two engines' process records must not mix,
 * or `obrew engine status` would report sd-server as a llama-server.
 *
 *   engines/<tag>-<variant>/    sd-server + sd-cli and their libraries; engine.json records them
 *   engines/.cache/             verified archives worth keeping across tag bumps (CUDA runtime)
 *   models/<org>--<repo>/<path> component files, at their path in the repo (no flattening)
 *   upscalers/                  ESRGAN models, flat: sd-server scans only the top level
 *   engine/shared.json          the warm sd-server
 *   engine/running/, jobs/      process and job records, for the orphan reapers
 *   engine/model-root/          an empty `--model-dir`, so sd-server scans nothing at startup
 *   logs/sd-server.log          the engine's stdout and stderr (it has no --log-file)
 *   config.json  models.json  hardware.json
 */
import { join } from 'node:path'
import { dataDir } from '../shared/paths'

export const imageDir = () => join(dataDir(), 'image')
export const imageEnginesDir = () => join(imageDir(), 'engines')
export const imageCacheDir = () => join(imageEnginesDir(), '.cache')
export const imageModelsDir = () => join(imageDir(), 'models')
export const upscalersDir = () => join(imageDir(), 'upscalers')
export const imageEngineStateDir = () => join(imageDir(), 'engine')
export const imageSharedRecordPath = () => join(imageEngineStateDir(), 'shared.json')
export const imageRunningDir = () => join(imageEngineStateDir(), 'running')
export const imageJobsDir = () => join(imageEngineStateDir(), 'jobs')
export const modelRootDir = () => join(imageEngineStateDir(), 'model-root')
export const imageLogsDir = () => join(imageDir(), 'logs')
export const serverLogPath = () => join(imageLogsDir(), 'sd-server.log')
export const imageTmpDir = () => join(imageDir(), 'tmp')
export const imageConfigPath = () => join(imageDir(), 'config.json')
export const imageRegistryPath = () => join(imageDir(), 'models.json')
export const hardwarePath = () => join(imageDir(), 'hardware.json')
