// Read an image's pixel size from its first bytes, without downloading the whole file.
// Covers JPEG, PNG, GIF and WebP. AVIF and others return null (size stays unknown).

export function imageSize(b: Uint8Array): { width: number; height: number; type: string } | null {
  if (b.length < 24) return null;
  // PNG: 89 50 4E 47 ... IHDR width/height at 16..23
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: be32(b, 16), height: be32(b, 20), type: 'png' };
  }
  // GIF: "GIF8"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8), type: 'gif' };
  }
  // WebP: "RIFF" .... "WEBP"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8X' && b.length >= 30) {
      return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), type: 'webp' };
    }
    if (chunk === 'VP8 ' && b.length >= 30) {
      return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff, type: 'webp' };
    }
    if (chunk === 'VP8L' && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: 'webp' };
    }
    return null;
  }
  // JPEG: FF D8, then walk markers to the first SOFn
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = (b[i + 2] << 8) | b[i + 3];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], type: 'jpeg' };
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

function be32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/** Fetch at most `limit` bytes of an image and read its size. Never throws. */
export async function sniffRemoteSize(url: string, limit = 96 * 1024, timeoutMs = 8000): Promise<{ width: number; height: number } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${limit - 1}`, 'User-Agent': 'Mozilla/5.0 (compatible; SaltAtlasBot/1.0; +https://www.saltatlas.com)' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok || !res.body) return null;
    const type = res.headers.get('content-type') || '';
    if (type && !type.startsWith('image/') && !type.includes('octet-stream')) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.length;
      const size = imageSize(concat(chunks, total));
      if (size) {
        await reader.cancel().catch(() => {});
        return size.width > 0 && size.height > 0 ? { width: size.width, height: size.height } : null;
      }
    }
    await reader.cancel().catch(() => {});
    const size = imageSize(concat(chunks, total));
    return size && size.width > 0 && size.height > 0 ? { width: size.width, height: size.height } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
