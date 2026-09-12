/**
 * Compile to a standalone executable.
 *
 *   bun run build.ts                    host platform -> ./obrew[.exe]
 *   bun run build.ts --all              all targets   -> dist/ (+ SHA256SUMS)
 *   bun run build.ts --target=linux-x64 one target    -> dist/
 *
 * Trimmed from bunview/build.ts: no icon pipeline, no .app bundle, no .desktop file — this is
 * a CLI, and the host app that installs it (motionbuff) verifies the SHA-256 that the release
 * workflow publishes next to each asset.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { z } from 'zod'

const TARGETS = [
  { name: 'windows-x64', target: 'bun-windows-x64', ext: '.exe' },
  { name: 'darwin-arm64', target: 'bun-darwin-arm64', ext: '' },
  { name: 'darwin-x64', target: 'bun-darwin-x64', ext: '' },
  { name: 'linux-x64', target: 'bun-linux-x64', ext: '' },
  { name: 'linux-arm64', target: 'bun-linux-arm64', ext: '' },
] as const

const APP_NAME = 'obrew'
const PUBLISHER = 'OpenBrew.ai'
/** Fixed, not the wall clock, so a rebuild of the same commit produces the same bytes. */
const COPYRIGHT_YEAR = '2026'

const PackageSchema = z.object({
  version: z.string().regex(/^\d+(\.\d+)*([-+].*)?$/, 'must start with dot-separated numbers'),
  description: z.string().min(1),
})
const parsedPkg = PackageSchema.safeParse(await Bun.file('./package.json').json())
if (!parsedPkg.success) {
  console.error('✗ package.json is missing or malformed where the build reads it:')
  for (const issue of parsedPkg.error.issues) {
    console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
  }
  process.exit(1)
}
const pkg = parsedPkg.data

const WIN_VERSION = pkg.version
  .split(/[-+]/)[0]!
  .split('.')
  .concat('0', '0', '0')
  .slice(0, 4)
  .join('.')

const windowsMetadata = {
  title: 'Obrew',
  publisher: PUBLISHER,
  version: WIN_VERSION,
  description: pkg.description,
  copyright: `© ${COPYRIGHT_YEAR} ${PUBLISHER}`,
  // A CLI: the console IS the interface.
  hideConsole: false,
}

const args = process.argv.slice(2)
const buildAll = args.includes('--all')
const targetArg = args.find((a) => a.startsWith('--target='))?.split('=')[1]

async function buildTarget(outfile: string, target?: string) {
  const isWindows = target ? target.includes('windows') : process.platform === 'win32'
  const result = await Bun.build({
    entrypoints: ['./src/main.ts'],
    compile: {
      outfile,
      ...(target ? { target: target as never } : {}),
      ...(isWindows ? { windows: windowsMetadata } : {}),
    },
    minify: true,
    sourcemap: 'linked',
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error('Build failed')
  }
}

async function sha256Of(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(path).stream() as unknown as AsyncIterable<Uint8Array>) {
    hasher.update(chunk)
  }
  return hasher.digest('hex')
}

if (buildAll || targetArg) {
  mkdirSync('dist', { recursive: true })
  const selected = buildAll ? TARGETS : TARGETS.filter((t) => t.name === targetArg)
  if (selected.length === 0) {
    console.error(`Unknown target: ${targetArg}\nAvailable: ${TARGETS.map((t) => t.name).join(', ')}`)
    process.exit(1)
  }

  const sums: string[] = []
  for (const { name, target, ext } of selected) {
    const file = `${APP_NAME}-${name}${ext}`
    const outfile = `dist/${file}`
    console.log(`Building for ${name}...`)
    try {
      await buildTarget(outfile, target)
      sums.push(`${await sha256Of(outfile)}  ${file}`)
      console.log(`  → ${outfile}`)
    } catch (e) {
      console.error(`  ✗ Failed to build for ${name}`, e)
      process.exit(1)
    }
  }
  writeFileSync('dist/SHA256SUMS', sums.join('\n') + '\n')
  console.log('  → dist/SHA256SUMS\n\nDone!')
} else {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const outfile = `./${APP_NAME}${ext}`
  try {
    await buildTarget(outfile)
    console.log(`Build successful!\n  → ${outfile}`)
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
}
