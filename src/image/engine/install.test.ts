/**
 * Installing sd-server from a fake GitHub release (OBREW_RELEASE_API) whose assets are real zips
 * holding a shell script that answers `--help` and `--list-devices` like the real build: the
 * record it writes (flags and devices), finding it again (and the OBREW_SD_SERVER override), the
 * refusals (no digest, no asset or two, a build that will not start, an unpublished variant),
 * the shallowest binary winning, and the parsers for --help, --list-devices and launch failures.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { tempHome } from '../../../test/fixtures/home'
import { fakeHardware, MASTER_987_ASSETS } from '../../../test/fixtures/image'
import { writeZip, type ZipEntry } from '../../../test/fixtures/zip'
import { hostArch, hostPlatform } from '../../engine/variant'
import { loadImageConfig } from '../config'
import { hardwarePath, imageConfigPath, imageEnginesDir, imageTmpDir } from '../paths'
import {
  findImageEngine,
  imageEngineStatus,
  installImageEngine,
  launchFailure,
  parseDevices,
  parseHelpFlags,
  requireImageEngine,
} from './install'
import { assetPatterns, IMAGE_VARIANTS, publishedVariants } from './variant'
import { SDCPP_REPO, SDCPP_TAG } from './version'

const encode = (s: string) => new TextEncoder().encode(s)
const sha = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

/** Abridged from sd-server --help on master-987: every option line shape the parser meets. */
const HELP = `usage: sd-server [options]

Svr Options:
  -l, --listen-ip <string>                 server listen ip (default: 127.0.0.1)
  --listen-port <int>                      server listen port (default: 1234)
  --list-devices                           list available devices and exit
  -h, --help                               show this help message and exit

Context Options:
  --diffusion-model <string>               path to the standalone diffusion model
  --clip_l <string>                        path to the clip-l text encoder
  --offload-to-cpu                         place the weights in RAM to save VRAM, and automatically load them into VRAM when needed
  --vae-tiling                             process vae in tiles to reduce memory usage (see also --vae-tile-size)
`
const HELP_FLAGS = [
  '--listen-ip',
  '--listen-port',
  '--list-devices',
  '--help',
  '--diffusion-model',
  '--clip_l',
  '--offload-to-cpu',
  '--vae-tiling',
]

/** sd-server as a shell script: help on --help, one CPU device on --list-devices, exit 0. */
const SD_SERVER = `#!/bin/sh
case "$1" in
  --help)
    cat <<'EOF'
${HELP}EOF
    ;;
  --list-devices)
    printf 'CPU\\tFake CPU\\n'
    ;;
esac
exit 0
`
const SD_CLI = '#!/bin/sh\nexit 0\n'
const DECOY = '#!/bin/sh\necho "the deeper copy ran" >&2\nexit 3\n'
/** What the dynamic loader prints for a build linked against a newer glibc than the system's. */
const OLD_GLIBC = `#!/bin/sh
cat >&2 <<'EOF'
./sd-server: /lib/x86_64-linux-gnu/libc.so.6: version \`GLIBC_2.38' not found (required by ./sd-server)
EOF
exit 1
`

const exe = (name: string, script: string): ZipEntry => ({
  name,
  data: encode(script),
  mode: 0o755,
})

/** The asset name the host's cpu variant installs from, or undefined where none can run here. */
const HOST_PATTERN =
  process.platform === 'win32'
    ? null
    : (assetPatterns('cpu', hostPlatform(), hostArch())?.[0] ?? null)
const HOST_ASSET = HOST_PATTERN
  ? MASTER_987_ASSETS.find((name) => HOST_PATTERN.test(name))
  : undefined

let home: Awaited<ReturnType<typeof tempHome>>
let savedOverride: string | undefined
beforeEach(async () => {
  home = await tempHome()
  savedOverride = process.env.OBREW_SD_SERVER
  delete process.env.OBREW_SD_SERVER
  // A fresh hardware cache, so the install reads it instead of probing this machine.
  await mkdir(dirname(hardwarePath()), { recursive: true })
  await Bun.write(
    hardwarePath(),
    JSON.stringify(
      fakeHardware({ platform: hostPlatform(), arch: hostArch(), detectedAt: Date.now() }),
    ),
  )
})
afterEach(async () => {
  if (savedOverride === undefined) delete process.env.OBREW_SD_SERVER
  else process.env.OBREW_SD_SERVER = savedOverride
  await home.cleanup()
})

describe.skipIf(!HOST_ASSET)('installImageEngine', () => {
  const asset = HOST_ASSET!
  let server: ReturnType<typeof Bun.serve>
  let work: string
  let savedApi: string | undefined
  let downloads: string[] = []
  /** tag → the release's assets: the zip on disk, and whether GitHub recorded its digest. */
  const releases = new Map<string, Array<{ name: string; path: string; digest: boolean }>>()

  async function release(
    tag: string,
    assets: Array<{ name: string; entries: ZipEntry[]; digest?: boolean }>,
  ) {
    const list = []
    for (const a of assets) {
      const path = join(work, tag, a.name)
      await mkdir(dirname(path), { recursive: true })
      await writeZip(path, a.entries)
      list.push({ name: a.name, path, digest: a.digest ?? true })
    }
    releases.set(tag, list)
  }

  beforeAll(async () => {
    work = await realpath(await mkdtemp(join(tmpdir(), 'obrew-sd-release-')))
    const build = [
      exe('sd-server', SD_SERVER),
      exe('sd-cli', SD_CLI),
      { name: 'libstable-diffusion.so', data: encode('lib') },
    ]
    await release(SDCPP_TAG, [{ name: asset, entries: build }])
    await release('no-digest', [{ name: asset, entries: build, digest: false }])
    await release('renamed', [{ name: asset.replace(/\.zip$/, '-renamed.zip'), entries: build }])
    await release('duplicated', [
      { name: asset, entries: build },
      { name: asset.replace(/(macOS|Ubuntu)-[\d.]+/, '$1-99.0'), entries: build },
    ])
    // The Linux ROCm zip's layout: the binaries under build/bin/, here with a second, deeper copy.
    await release('nested', [
      {
        name: asset,
        entries: [
          { name: 'build/' },
          { name: 'build/bin/' },
          { name: 'build/bin/extra/' },
          exe('build/bin/extra/sd-server', DECOY),
          exe('build/bin/sd-server', SD_SERVER),
          exe('build/bin/sd-cli', SD_CLI),
        ],
      },
    ])
    await release('old-glibc', [{ name: asset, entries: [exe('sd-server', OLD_GLIBC)] }])

    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const tag = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/releases\/tags\/([^/]+)$/)
        if (tag && tag[1] === SDCPP_REPO) {
          const assets = releases.get(decodeURIComponent(tag[2]!))
          if (!assets) return Response.json({ message: 'Not Found' }, { status: 404 })
          return Response.json({
            tag_name: tag[2],
            assets: await Promise.all(
              assets.map(async (a) => {
                const bytes = await Bun.file(a.path).bytes()
                return {
                  name: a.name,
                  browser_download_url: `http://127.0.0.1:${server.port}/dl/${tag[2]}/${a.name}`,
                  size: bytes.length,
                  digest: a.digest ? `sha256:${sha(bytes)}` : null,
                }
              }),
            ),
          })
        }
        const dl = url.pathname.match(/^\/dl\/([^/]+)\/(.+)$/)
        if (dl) {
          downloads.push(url.pathname)
          const a = releases.get(dl[1]!)?.find((x) => x.name === dl[2])
          return a ? new Response(Bun.file(a.path)) : new Response('nf', { status: 404 })
        }
        return new Response('nf', { status: 404 })
      },
    })
    savedApi = process.env.OBREW_RELEASE_API
    process.env.OBREW_RELEASE_API = `http://127.0.0.1:${server.port}`
  })
  afterAll(async () => {
    server.stop(true)
    if (savedApi === undefined) delete process.env.OBREW_RELEASE_API
    else process.env.OBREW_RELEASE_API = savedApi
    await rm(work, { recursive: true, force: true })
  })
  beforeEach(() => {
    downloads = []
  })

  const install = (tag?: string, logs?: string[]) =>
    installImageEngine({
      tag,
      variant: 'cpu',
      signal: new AbortController().signal,
      onLog: (m) => logs?.push(m),
    })

  test('downloads, verifies and unpacks the build, runs it, and records its flags and devices', async () => {
    const logs: string[] = []
    const record = await install(undefined, logs)
    const dir = join(imageEnginesDir(), `${SDCPP_TAG}-cpu`)
    expect(record).toMatchObject({
      tag: SDCPP_TAG,
      variant: 'cpu',
      server: join(dir, 'sd-server'),
      cli: join(dir, 'sd-cli'),
      binDir: dir,
      flags: HELP_FLAGS,
      devices: ['CPU'],
    })
    expect(downloads).toEqual([`/dl/${SDCPP_TAG}/${asset}`])
    expect(logs).toContain(`downloading ${asset}`)
    expect(logs).toContain('checking that sd-server runs')
    expect((await stat(record.server)).mode & 0o111).not.toBe(0)
    expect(await Bun.file(join(dir, 'engine.json')).json()).toEqual(record)
    expect(await loadImageConfig()).toEqual({ variant: 'cpu' })
    // The download's staging directory is gone.
    expect(existsSync(join(imageTmpDir(), `engine-${SDCPP_TAG}-cpu`))).toBe(false)
  })

  test('findImageEngine finds it: by the configured variant, else any variant of the pinned tag', async () => {
    const record = await install()
    expect(await findImageEngine()).toEqual(record)
    expect(await findImageEngine({ variant: 'vulkan' })).toEqual(record)
    await rm(imageConfigPath())
    expect(await findImageEngine()).toEqual(record)
    expect(await imageEngineStatus()).toEqual({
      installed: true,
      tag: SDCPP_TAG,
      variant: 'cpu',
      server: record.server,
    })
    // A record whose binary is gone does not count.
    await rm(record.server)
    expect(await findImageEngine()).toBeNull()
    await expect(requireImageEngine()).rejects.toMatchObject({ code: 'engine_missing' })
  })

  test('an asset the release records no digest for is refused, and nothing is downloaded', async () => {
    await expect(install('no-digest')).rejects.toMatchObject({
      code: 'engine_failed',
      message: `${asset} carries no checksum on the release, so it was not installed`,
    })
    expect(downloads).toEqual([])
    expect(existsSync(join(imageEnginesDir(), 'no-digest-cpu'))).toBe(false)
  })

  test('no matching asset, or two, is an error that names them rather than a guess', async () => {
    await expect(install('renamed')).rejects.toMatchObject({
      code: 'engine_failed',
      message: expect.stringContaining('no asset matching'),
    })
    await expect(install('duplicated')).rejects.toMatchObject({
      code: 'engine_failed',
      message: expect.stringContaining('2 assets match'),
    })
    expect(downloads).toEqual([])
  })

  test('the shallowest sd-server wins, and its directory is the binary directory', async () => {
    const record = await install('nested')
    const bin = join(imageEnginesDir(), 'nested-cpu', 'build', 'bin')
    expect(record).toMatchObject({
      server: join(bin, 'sd-server'),
      cli: join(bin, 'sd-cli'),
      binDir: bin,
      flags: HELP_FLAGS,
      devices: ['CPU'],
    })
  })

  test('a build that cannot start fails the install with the reason, and records nothing', async () => {
    await expect(install('old-glibc')).rejects.toMatchObject({
      code: 'engine_failed',
      message: expect.stringContaining('needs glibc 2.38 or newer'),
    })
    expect(existsSync(join(imageEnginesDir(), 'old-glibc-cpu', 'engine.json'))).toBe(false)
    expect(await loadImageConfig()).toEqual({})
  })
})

describe('installImageEngine without a release', () => {
  test('a variant not published here says which are', async () => {
    const platform = hostPlatform()
    const arch = hostArch()
    const missing = IMAGE_VARIANTS.find((v) => !assetPatterns(v, platform, arch))!
    const published = publishedVariants(platform, arch)
    await expect(
      installImageEngine({ variant: missing, signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: 'engine_failed',
      message: expect.stringContaining(
        published.length
          ? `published here: ${published.join(', ')}`
          : 'none is published for this platform',
      ),
    })
  })
})

describe('findImageEngine', () => {
  test('nothing installed: null', async () => {
    expect(await findImageEngine()).toBeNull()
    expect(await imageEngineStatus({})).toEqual({
      installed: false,
      tag: SDCPP_TAG,
      variant: null,
      server: null,
    })
  })

  test('OBREW_SD_SERVER is taken at its word, flags unknown; a path that does not exist is a hard failure', async () => {
    const custom = join(home.dir, 'my-build', 'sd-server')
    await mkdir(dirname(custom), { recursive: true })
    await writeFile(custom, '')
    process.env.OBREW_SD_SERVER = custom
    expect(await findImageEngine()).toEqual({
      tag: 'custom',
      variant: 'custom',
      server: custom,
      cli: null,
      binDir: dirname(custom),
      flags: [],
      devices: [],
      installedAt: '',
    })
    process.env.OBREW_SD_SERVER = join(home.dir, 'nope')
    await expect(findImageEngine()).rejects.toMatchObject({
      code: 'engine_missing',
      message: expect.stringContaining('OBREW_SD_SERVER'),
    })
  })
})

describe('parseHelpFlags', () => {
  test('every long flag at the start of an option line, short form or not, in order', () => {
    expect(parseHelpFlags(HELP)).toEqual(HELP_FLAGS)
  })

  test('not flags named in prose or in an unindented line; each flag once; CRLF is fine', () => {
    const help = [
      '--not-an-option at column 0',
      '  --steps <int>   sample steps (see --cfg-scale)',
      '  --steps <int>   listed twice',
      '  -s, --seed <int>',
    ].join('\r\n')
    expect(parseHelpFlags(help)).toEqual(['--steps', '--seed'])
    expect(parseHelpFlags('')).toEqual([])
  })
})

describe('parseDevices', () => {
  test('the name before the tab on each line', () => {
    expect(parseDevices('CPU\tFake CPU\n')).toEqual(['CPU'])
    expect(parseDevices('MTL0\tApple M4\r\nBLAS\tAccelerate\r\nCPU\tApple M4\r\n')).toEqual([
      'MTL0',
      'BLAS',
      'CPU',
    ])
    expect(
      parseDevices(
        'Vulkan0\tAMD Radeon RX 6600 (RADV NAVI23)\nCPU\tAMD Ryzen 5 5600X 6-Core Processor\n',
      ),
    ).toEqual(['Vulkan0', 'CPU'])
  })

  test('headings and blank lines are not devices', () => {
    expect(parseDevices('Available devices:\n\n  CUDA0\tNVIDIA GeForce RTX 4060\n')).toEqual([
      'CUDA0',
    ])
    expect(parseDevices('')).toEqual([])
  })
})

describe('launchFailure', () => {
  test('a glibc too old for the build names the version it needs', () => {
    const stderr =
      "/x/sd-server: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found (required by /x/sd-server)"
    expect(launchFailure({ code: 1, stdout: '', stderr })).toContain('needs glibc 2.38 or newer')
  })

  test('STATUS_DLL_NOT_FOUND (0xC0000135), as either sign, names the Visual C++ runtime', () => {
    for (const code of [0xc0000135, -1073741515]) {
      expect(launchFailure({ code, stdout: '', stderr: '' })).toContain(
        'Microsoft Visual C++ Redistributable',
      )
    }
  })

  test('anything else: the exit code and the last eight lines of output', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`)
    const message = launchFailure({
      code: 2,
      stdout: lines.slice(6).join('\n'),
      stderr: lines.slice(0, 6).join('\n'),
    })
    expect(message).toBe(`sd-server did not start (exit 2):\n${lines.slice(4).join('\n')}`)
    expect(launchFailure({ code: null, stdout: '', stderr: '' })).toBe(
      'sd-server did not start (exit killed)',
    )
  })
})
