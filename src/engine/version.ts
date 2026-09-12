/**
 * The llama.cpp release this build of obrew installs.
 *
 * Read from package.json so there is exactly one place to bump it — the same
 * `llamacpp_tag` key obrew-engine's CI used. Bundled into the compiled binary by the
 * JSON import, so a release of obrew pins a release of llama.cpp.
 */
import pkg from '../../package.json' with { type: 'json' }

export const LLAMACPP_TAG: string = pkg.llamacpp_tag
export const LLAMACPP_REPO = 'ggml-org/llama.cpp'
