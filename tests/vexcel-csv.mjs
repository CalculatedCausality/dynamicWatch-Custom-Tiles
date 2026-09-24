import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureCsv, parseArgs } from '../scripts/vexcel-capture.mjs';
import { parseAddressCsv } from '../scripts/vexcel-csv.mjs';

test('CSV reads quoted addresses and optional matched coordinates', () => {
  assert.deepEqual(parseAddressCsv('address,lat,lon\n"34 Cottman St, Buderim",-26.68,153.04\n"House ""B"", Road",,\n'), [
    { address: '34 Cottman St, Buderim', coordinates: { lat: '-26.68', lon: '153.04' } },
    { address: 'House "B", Road', coordinates: undefined },
  ]);
  assert.throws(() => parseAddressCsv('address,lat,lon\nOne,12,\n'), /both lat and lon/);
  assert.throws(() => parseAddressCsv('address\n"Broken'), /Unterminated/);
  assert.equal(parseArgs(['--csv', 'my.csv', '--output', 'out', '--no-open']).csv, 'my.csv');
  assert.throws(() => parseArgs(['--csv', 'my.csv', 'Extra']), /--csv accepts only/);
});

test('batch saves independent reports, an index and failure rows without leaking tokens', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vexcel-batch-'));
  try {
    const csv = path.join(dir, 'addresses.csv');
    await writeFile(csv, 'address,lat,lon\n"First, Queensland",-26.68,153.04\n"Second, Queensland",-26.69,153.03\n');
    const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
    const image = Buffer.from([0xff,0xd8,0xff,0xc0,0,0x11,8,0,1,0,1,3,1,0x11,0,2,0x11,0,3,0x11,0,0xff,0xda,0,8,1,1,0,0,0x3f,0,0x11,0xff,0xd9]);
    const reply = (value, type = 'application/json') => ({ ok: true, status: 200,
      headers: { get: () => type }, json: async () => value,
      arrayBuffer: async () => Uint8Array.from(value).buffer });
    const fetcher = async (url, opts) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/init')) return reply({ session: 'SESSION' });
      if (u.pathname.endsWith('/query')) {
        if (JSON.parse(opts.body).wkt.includes('-26.69')) return reply({ features: [] });
        return reply({ features: ['north','east','south','west'].map((d) => ({
          properties: { collection: '2025', 'product-type': 'oblique-' + d,
            'image-name': `image_${d}_rgb`, 'raster-size-width': 1,
            'raster-size-height': 1, 'capture-date': '2025-01-01' },
        })) });
      }
      if (u.pathname.endsWith('/tile')) return reply(image, 'image/jpeg');
      if (u.pathname.endsWith('/transform-points')) return reply({ points: [] });
      throw new Error('Unexpected geocoder or network call');
    };
    const result = await captureCsv(csv, { output: path.join(dir, 'out'), fetcher,
      env: { VEXCEL_TOKEN: token }, delay: async () => { throw new Error('No geocoding delay for manual points'); } });
    assert.equal(result.completed, 1);
    assert.equal(result.failed, 1);
    const index = await readFile(result.indexPath, 'utf8');
    assert.match(index, /001-First-Queensland.html/);
    assert.match(index, /Second, Queensland/);
    assert.doesNotMatch(index, /SESSION|signature|token=/);
    assert.match(await readFile(path.join(dir, 'out', '001-First-Queensland.html'), 'utf8'), /First, Queensland/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
