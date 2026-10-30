/**
 * The stable-diffusion.cpp release this build of obrew installs for image generation.
 *
 * stable-diffusion.cpp publishes a release for every merged commit (`master-<build>-<hash>`)
 * and warns that flags change often, so obrew pins one it has tested, the same way
 * `llamacpp_tag` pins llama.cpp: one key in package.json, bundled into the binary by the JSON
 * import. A bump is that key, a smoke run per backend (`bun run smoke:image`), and nothing else.
 */
import pkg from '../../../package.json' with { type: 'json' }

export const SDCPP_TAG: string = pkg.sdcpp_tag
export const SDCPP_REPO = 'leejet/stable-diffusion.cpp'
