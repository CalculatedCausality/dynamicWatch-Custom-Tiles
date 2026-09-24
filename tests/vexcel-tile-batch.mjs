import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadTileBatch } from '../scripts/vexcel-tile-batch.mjs';

const job = (x, extra = {}) => ({ imageName: 'photo_rgb', layer: 'urban',
  downsample: 0, x, y: 0, expectedWidth: 256, expectedHeight: 256, ...extra });

function jpeg(label = 1, width = 256, height = 256) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 255, width >> 8, width & 255,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    label, 0xff, 0xd9]);
}

async function withCache(run) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'vexcel-tiles-'));
  try { await run(cacheDir); }
  finally { await rm(cacheDir, { recursive: true, force: true }); }
}

test('failure preserves only valid tiles; retry resumes missing jobs in input order', async () => {
  await withCache(async (cacheDir) => {
    const jobs = [job(0), job(1), job(2)];
    const fetched = [], progress = [];
    const fetchTile = async (tile) => {
      fetched.push(tile.x);
      if (tile.x === 1 && fetched.filter((x) => x === 1).length === 1) {
        return jpeg(2).subarray(0, -2); // truncated HTTP 200 is not cached
      }
      return jpeg(tile.x + 1);
    };
    await assert.rejects(downloadTileBatch(jobs, { cacheDir, fetchTile, concurrency: 1,
      onProgress: (event) => progress.push(event),
    }), /Invalid tile bytes/);
    assert.deepEqual(fetched, [0, 1]);
    assert.equal((await readdir(cacheDir)).length, 1);
    assert.deepEqual(progress.map(({ index }) => index), [0]);

    const bytes = await downloadTileBatch(jobs, { cacheDir, fetchTile, concurrency: 2,
      onProgress: (event) => progress.push(event),
    });
    assert.deepEqual(fetched, [0, 1, 1, 2]);
    assert.deepEqual(bytes, [jpeg(1), jpeg(2), jpeg(3)]);
    assert.deepEqual(progress.slice(1).map(({ index, source }) => [index, source]).sort(),
      [[0, 'cache'], [1, 'network'], [2, 'network']]);
    const files = await readdir(cacheDir);
    assert.equal(files.length, 3);
    assert.ok(files.every((file) => /^[a-f0-9]{64}\.jpg$/.test(file)));
  });
});

test('deduplicates by tile identity, ignoring secrets, and validates cached bytes again', async () => {
  await withCache(async (cacheDir) => {
    const jobs = [job(0, { url: 'https://example.test/?token=old', session: 'OLD' }),
      job(1), job(0, { url: 'https://example.test/?token=new', session: 'NEW' })];
    const calls = [], progress = [];
    const fetchTile = async (tile) => { calls.push(tile.x); return jpeg(tile.x + 1); };
    const first = await downloadTileBatch(jobs, { cacheDir, fetchTile,
      onProgress: (event) => progress.push(event),
    });
    assert.deepEqual(calls.sort(), [0, 1]);
    assert.deepEqual(first, [jpeg(1), jpeg(2), jpeg(1)]);
    assert.deepEqual(progress.map(({ index }) => index).sort(), [0, 1, 2]);
    const files = await readdir(cacheDir);
    assert.equal(files.length, 2);
    assert.ok(files.every((file) => !/token|session|old|new|example/i.test(file)));
    assert.deepEqual(await downloadTileBatch([job(0, { session: 'OTHER' }), job(0)], {
      cacheDir, fetchTile: () => { throw new Error('should use cache'); },
    }), [jpeg(1), jpeg(1)]);

    const cachedZero = await Promise.all(files.map(async (file) => ({ file,
      bytes: await readFile(path.join(cacheDir, file)),
    })));
    const zeroFile = cachedZero.find(({ bytes }) => bytes.equals(jpeg(1))).file;
    await writeFile(path.join(cacheDir, zeroFile), Buffer.from('bad cached response'));
    const repaired = await downloadTileBatch([job(0), job(0)], { cacheDir, fetchTile });
    assert.deepEqual(repaired, [jpeg(1), jpeg(1)]);
    assert.equal(calls.filter((x) => x === 0).length, 2);
    assert.deepEqual(await readFile(path.join(cacheDir, zeroFile)), jpeg(1));
    assert.equal((await readdir(cacheDir)).length, 2, 'atomic writes leave no temp files');
  });
});

test('permanent failure aborts other in-flight tiles and prevents pending work', async () => {
  await withCache(async (cacheDir) => {
    let releaseFailure;
    const started = [], aborted = [];
    const fetchTile = (tile, { signal }) => {
      started.push(tile.x);
      if (tile.x === 0) return new Promise((_, reject) => {
        releaseFailure = () => reject(new Error('permanent failure'));
      });
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted.push(tile.x);
          reject(signal.reason);
        }, { once: true });
      });
    };
    const pending = downloadTileBatch([job(0), job(1), job(2), job(3)], {
      cacheDir, fetchTile, concurrency: 2,
    });
    // fetchTile is called from workers after the initial async mkdir.
    while (started.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    releaseFailure();
    await assert.rejects(pending, /permanent failure/);
    assert.deepEqual(started, [0, 1]);
    assert.deepEqual(aborted, [1]);
    assert.deepEqual(await readdir(cacheDir), []);
  });
});

test('caller abort cancels in-flight jobs and prevents later cache hits or downloads', async () => {
  await withCache(async (cacheDir) => {
    const controller = new AbortController();
    const reason = new Error('user cancelled');
    let started = 0, aborted = 0;
    const pending = downloadTileBatch([job(0), job(1), job(2)], {
      cacheDir, concurrency: 2, signal: controller.signal,
      fetchTile: (_, { signal }) => new Promise((_, reject) => {
        started++;
        signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true });
      }),
    });
    while (started < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(started, 2);
    assert.equal(aborted, 2);
    assert.deepEqual(await readdir(cacheDir), []);
    await assert.rejects(downloadTileBatch([job(0)], { cacheDir, signal: controller.signal,
      fetchTile: () => { throw new Error('must not fetch'); },
    }), (error) => error === reason);
  });
});

test('bounds concurrency and rejects mismatched JPEG dimensions', async () => {
  await withCache(async (cacheDir) => {
    let active = 0, peak = 0;
    const jobs = Array.from({ length: 6 }, (_, x) => job(x));
    const result = await downloadTileBatch(jobs, { cacheDir, concurrency: 3,
      fetchTile: async (tile) => {
        active++; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active--;
        return Uint8Array.from(jpeg(tile.x + 1));
      },
    });
    assert.equal(peak, 3);
    assert.deepEqual(result, jobs.map((tile) => jpeg(tile.x + 1)));
    await assert.rejects(downloadTileBatch([job(9, { expectedWidth: 128, expectedHeight: 200 })], {
      cacheDir, fetchTile: async () => jpeg(1, 127, 200),
    }), /Invalid tile bytes/);
    assert.equal((await readdir(cacheDir)).length, 6);
  });
});

test('cache identity includes layer, downsample and both coordinates; custom validation supports other binaries', async () => {
  await withCache(async (cacheDir) => {
    const jobs = [job(0), job(0, { layer: 'wide-area' }), job(0, { downsample: 1 }),
      job(0, { y: 1 }), job(1)];
    let fetches = 0;
    const validateTile = async (bytes) => bytes.toString() === 'custom tile';
    const fetchTile = async () => { fetches++; return Uint8Array.from(Buffer.from('custom tile')).buffer; };
    assert.deepEqual(await downloadTileBatch(jobs, { cacheDir, fetchTile, validateTile }),
      jobs.map(() => Buffer.from('custom tile')));
    assert.equal(fetches, 5);
    assert.equal((await readdir(cacheDir)).length, 5);
    await downloadTileBatch(jobs, { cacheDir, fetchTile, validateTile });
    assert.equal(fetches, 5);
  });
});
