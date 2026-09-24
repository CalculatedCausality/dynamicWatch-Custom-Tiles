import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

// Only touch tiles produced by the Vexcel batch downloader. Prune old tiles
// first, then cap disk usage by evicting the oldest remaining tiles.
export async function pruneTileCache(cacheDir, { maxAgeDays = 30,
  maxBytes = 512 * 1024 * 1024, now = Date.now() } = {}) {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0 ||
      !Number.isFinite(maxBytes) || maxBytes < 0) throw new TypeError('Invalid cache limits');
  let names;
  try { names = await readdir(cacheDir); }
  catch (error) { if (error.code === 'ENOENT') return { removed: 0, bytes: 0 }; throw error; }
  const files = [];
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.jpg$/.test(name)) continue;
    const file = path.join(cacheDir, name);
    const info = await stat(file);
    if (info.isFile()) files.push({ file, size: info.size, modified: info.mtimeMs });
  }
  files.sort((a, b) => a.modified - b.modified);
  let bytes = files.reduce((sum, f) => sum + f.size, 0), removed = 0;
  for (const f of files) {
    if (now - f.modified <= maxAgeDays * 86400_000 && bytes <= maxBytes) continue;
    await unlink(f.file);
    bytes -= f.size;
    removed++;
  }
  return { removed, bytes };
}
