import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pruneTileCache } from '../scripts/vexcel-cache.mjs';

test('prune age and size limits without touching unrelated files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vexcel-cache-prune-'));
  try {
    const now = Date.now();
    const names = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)].map((n) => n + '.jpg');
    for (const [i, name] of names.entries()) {
      const file = path.join(dir, name);
      await writeFile(file, Buffer.alloc(5));
      await utimes(file, new Date(now - [40, 20, 1][i] * 86400_000), new Date(now - [40, 20, 1][i] * 86400_000));
    }
    await writeFile(path.join(dir, 'do-not-delete.txt'), 'mine');
    assert.deepEqual(await pruneTileCache(dir, { maxAgeDays: 30, maxBytes: 7, now }),
      { removed: 2, bytes: 5 });
    assert.deepEqual((await readdir(dir)).sort(), ['c'.repeat(64) + '.jpg', 'do-not-delete.txt']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
