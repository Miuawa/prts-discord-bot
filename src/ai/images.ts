// Images for API backends: Discord attachments (by URL) or files the bot
// saved (by path), loaded and base64-encoded for the request. Only the
// message being answered carries images; the history keeps text only.
import { readFileSync, statSync } from 'fs'

export type ImageRef = { name: string; mediaType: string; url?: string; path?: string; size?: number }
export type LoadedImage = { name: string; mediaType: string; data: string }

/** Formats both API backends accept. */
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export const MAX_IMAGES = Number(process.env.PRTS_MAX_IMAGES ?? 4)
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Picks the usable images from Discord-style attachments (name, contentType, size, url). */
export function imageRefs(atts: { name?: string | null; contentType?: string | null; size: number; url: string }[]): ImageRef[] {
  return atts
    .filter(a => IMAGE_TYPES.has((a.contentType ?? '').split(';')[0].trim()) && a.size <= MAX_IMAGE_BYTES)
    .slice(0, MAX_IMAGES)
    .map(a => ({ name: a.name ?? 'image', mediaType: (a.contentType ?? '').split(';')[0].trim(), url: a.url, size: a.size }))
}

export async function loadImages(refs: ImageRef[] | undefined): Promise<LoadedImage[]> {
  const out: LoadedImage[] = []
  for (const r of (refs ?? []).slice(0, MAX_IMAGES)) {
    try {
      let buf: Buffer
      if (r.path) {
        if (statSync(r.path).size > MAX_IMAGE_BYTES) continue
        buf = readFileSync(r.path)
      } else if (r.url) {
        const res = await fetch(r.url, { signal: AbortSignal.timeout(20_000) })
        if (!res.ok) continue
        buf = Buffer.from(await res.arrayBuffer())
        if (buf.length > MAX_IMAGE_BYTES) continue
      } else continue
      out.push({ name: r.name, mediaType: r.mediaType, data: buf.toString('base64') })
    } catch {
      // A broken or expired attachment: answer without it.
    }
  }
  return out
}
