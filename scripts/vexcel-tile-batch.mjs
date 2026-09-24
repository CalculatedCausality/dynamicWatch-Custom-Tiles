import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function jpegSize(bytes) {
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  for (let i = 2; i < bytes.length - 3;) {
    if (bytes[i++] !== 0xff) return null;
    while (bytes[i] === 0xff) i++;
    const marker = bytes[i++];
    if (marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (i + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(i);
    if (length < 2 || i + length > bytes.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 7) return null;
      return { width: bytes.readUInt16BE(i + 5), height: bytes.readUInt16BE(i + 3) };
    }
    i += length;
  }
  return null;
}

export function validJpeg(bytes, job) {
  const size = jpegSize(bytes);
  if (!size || size.width < 1 || size.height < 1) return false;
  if (job.expectedWidth == null) return true;
  return (size.width === job.expectedWidth && size.height === job.expectedHeight) ||
    (size.width === 256 && size.height === 256); // Vexcel sometimes pads edge tiles.
}

function cacheKey(job) {
  if (!job || typeof job.imageName !== 'string' || !job.imageName ||
      typeof job.layer !== 'string' || !job.layer ||
      ![job.downsample, job.x, job.y].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      (job.expectedWidth == null) !== (job.expectedHeight == null) ||
      (job.expectedWidth != null && ![job.expectedWidth, job.expectedHeight].every(
        (n) => Number.isSafeInteger(n) && n > 0 && n <= 256))) {
    throw new TypeError('Invalid tile descriptor');
  }
  // Deliberately enumerate only non-secret identity fields, never serialize the job.
  return createHash('sha256').update(JSON.stringify([
    job.imageName, job.layer, job.downsample, job.x, job.y,
  ])).digest('hex');
}

function asBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('fetchTile must return binary bytes');
}

async function atomicWrite(filename, bytes) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temp, filename);
  } finally {
    await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

/**
 * Download tiles in bounded parallelism, returning Buffer[] in input order.
 * jobs: { imageName, layer, downsample, x, y, expectedWidth?, expectedHeight? }[].
 * fetchTile(job, { signal }) must return binary bytes and honor signal. No URL,
 * token or session is used in the cache key or written to disk. The default
 * validator checks complete JPEG framing/SOF and optional edge dimensions;
 * validateTile(bytes, job) can replace it (return boolean, sync or async).
 * onProgress({ completed, total, index, source: 'cache' | 'network' }) runs
 * once per input job, including duplicates. Completed valid tiles survive a
 * failed/aborted batch for a later call with the same cacheDir and descriptors.
 */
export async function downloadTileBatch(jobs, { fetchTile, cacheDir, concurrency = 4,
  signal, onProgress, validateTile = validJpeg } = {}) {
  if (!Array.isArray(jobs) || typeof fetchTile !== 'function' ||
      typeof cacheDir !== 'string' || !cacheDir ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 ||
      typeof validateTile !== 'function' ||
      (onProgress != null && typeof onProgress !== 'function')) {
    throw new TypeError('Invalid tile batch options');
  }
  const groups = new Map();
  for (const [index, job] of jobs.entries()) {
    const key = cacheKey(job);
    if (!groups.has(key)) groups.set(key, { job, key, indices: [] });
    groups.get(key).indices.push(index);
  }
  signal?.throwIfAborted();
  if (!jobs.length) return [];

  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const batchSignal = controller.signal;
  const results = new Array(jobs.length);
  const pending = [...groups.values()];
  let cursor = 0, completed = 0, failure;

  async function checked(bytes, indices) {
    for (const index of indices) {
      if (!await validateTile(bytes, jobs[index])) return false;
      batchSignal.throwIfAborted();
    }
    return true;
  }

  async function worker() {
    while (cursor < pending.length && !batchSignal.aborted) {
      const { job, key, indices } = pending[cursor++];
      const filename = path.join(cacheDir, `${key}.jpg`);
      try {
        let bytes, source = 'cache';
        try { bytes = await readFile(filename); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        batchSignal.throwIfAborted();
        if (!bytes || !await checked(bytes, indices)) {
          source = 'network';
          bytes = asBytes(await fetchTile(job, { signal: batchSignal }));
          batchSignal.throwIfAborted();
          if (!await checked(bytes, indices)) throw new Error('Invalid tile bytes');
          batchSignal.throwIfAborted();
          await atomicWrite(filename, bytes);
        }
        batchSignal.throwIfAborted();
        for (const index of indices) {
          results[index] = bytes;
          completed++;
          await onProgress?.({ completed, total: jobs.length, index, source });
          batchSignal.throwIfAborted();
        }
      } catch (error) {
        if (!failure && !signal?.aborted) failure = error;
        controller.abort(error);
        return;
      }
    }
  }

  try {
    batchSignal.throwIfAborted();
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    batchSignal.throwIfAborted();
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
    if (signal?.aborted) signal.throwIfAborted();
    if (failure) throw failure;
    batchSignal.throwIfAborted();
    return results;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
