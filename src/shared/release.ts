/**
 * One GitHub release, by tag: the asset list both engine installers read.
 *
 * Shared by the text engine (llama.cpp) and the image engine (stable-diffusion.cpp) so the
 * lookup, the `OBREW_RELEASE_API` test override and the error wording exist once. Each asset
 * carries the `digest` GitHub records for it (`sha256:<hex>`), which is what an install verifies
 * the download against.
 */
import { z } from 'zod'
import { ObrewError } from './errors'

export const ReleaseSchema = z.object({
  tag_name: z.string().optional(),
  assets: z.array(
    z.object({
      name: z.string(),
      browser_download_url: z.string(),
      size: z.number(),
      digest: z.string().nullable().optional(),
    }),
  ),
})
export type Release = z.infer<typeof ReleaseSchema>
export type ReleaseAsset = Release['assets'][number]

/** `OBREW_RELEASE_API` lets tests (and mirrors) stand in for api.github.com. */
export const releaseApi = () => (process.env.OBREW_RELEASE_API ?? 'https://api.github.com').replace(/\/$/, '')

export async function fetchRelease(repo: string, tag: string, signal: AbortSignal): Promise<Release> {
  const res = await fetch(`${releaseApi()}/repos/${repo}/releases/tags/${tag}`, {
    signal,
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'obrew-cli' },
  })
  if (!res.ok) throw new ObrewError('engine_failed', `GitHub release lookup for ${repo} ${tag} failed: HTTP ${res.status}`)
  return ReleaseSchema.parse(await res.json())
}

/** The asset's SHA-256 as lowercase hex, or null when GitHub recorded none. */
export const assetSha256 = (asset: ReleaseAsset): string | null =>
  asset.digest ? asset.digest.replace(/^sha256:/, '').toLowerCase() : null
