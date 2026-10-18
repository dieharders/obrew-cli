/**
 * The engine releases this build of obrew installs.
 *
 * Read from package.json so there is exactly one place to bump each — the same
 * `llamacpp_tag` key obrew-engine's CI used. Bundled into the compiled binary by the
 * JSON import, so a release of obrew pins a release of each engine.
 *
 * `qwentts_repo` is a FORK, not upstream: ServeurpersoCom/qwentts.cpp publishes no binaries,
 * so the fork's release workflow builds the Windows / macOS / Linux archives obrew downloads.
 */
import pkg from '../../package.json' with { type: 'json' }

export const LLAMACPP_TAG: string = pkg.llamacpp_tag
export const LLAMACPP_REPO = 'ggml-org/llama.cpp'

export const QWENTTS_TAG: string = pkg.qwentts_tag
export const QWENTTS_REPO: string = pkg.qwentts_repo
