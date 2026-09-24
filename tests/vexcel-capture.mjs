import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  authenticate, buildReport, capture, downloadPhotos, formatLocationLog, geocode, loadLocalAuth,
  openLocationPreview, openReport, parseArgs,
  queryPhotos, selectPhotos, tileLayout, transformMarkers,
} from '../scripts/vexcel-capture.mjs';

const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
const directions = ['north', 'east', 'south', 'west'];
// A small JPEG with SOF and EOI; padded/cropped tile dimensions are set per request.
function tile(width = 1, height = 1) {
  return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 255, width >> 8, width & 255,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x11, 0xff, 0xd9]);
}
const reply = (data, status = 200, contentType = 'application/json') => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
  json: async () => data,
  arrayBuffer: async () => Uint8Array.from(data).buffer,
});
const feature = (direction, collection, date = '2025-01-01', width = 1, height = 1) => ({
  properties: {
    'product-type': `oblique-${direction}`, collection, 'capture-date': date,
    'image-name': `${collection}_${direction}_rgb`, 'source-layer': 'urban',
    'raster-size-width': width, 'raster-size-height': height,
  },
});

test('geocoding makes exactly one identified Nominatim request and rejects invalid coordinates', async () => {
  let calls = 0;
  const fetcher = async (url, init) => {
    calls++;
    assert.equal(url.hostname, 'nominatim.openstreetmap.org');
    assert.equal(url.searchParams.get('q'), '1 Test St');
    assert.match(init.headers['User-Agent'], /dynamicwatch-vexcel-capture/);
    assert.equal(url.searchParams.get('addressdetails'), '1');
    return reply([{ lat: '-27.47', lon: '153.02', address: { house_number: '1' },
      display_name: '1 Test Street, Brisbane' }]);
  };
  assert.deepEqual(await geocode('1 Test St', fetcher), { lat: -27.47, lon: 153.02,
    source: 'OpenStreetMap', matchedAddress: '1 Test Street, Brisbane' });
  assert.equal(calls, 1);
  await assert.rejects(geocode('bad', async () => reply([{ lat: '91', lon: '153' }])), /invalid WGS84/);
  await assert.rejects(geocode('bad', async () => reply(null, 503)), /both OpenStreetMap and ArcGIS/);
});

test('numbered addresses fall back to an exact ArcGIS point, never an approximate street result', async () => {
  const address = 'Unit 2, 157 Ann Street, Brisbane QLD';
  const candidates = [{ address: '157 Ann Street, Brisbane City', score: 100,
    location: { x: 153.0265, y: -27.466 },
    attributes: { Addr_type: 'PointAddress', AddNum: '157' } }];
  const requests = [];
  const fetcher = async (url) => {
    requests.push(url);
    if (url.hostname === 'nominatim.openstreetmap.org') {
      return reply([{ lat: '-27.4', lon: '153', address: { house_number: '155' } }]);
    }
    assert.equal(url.hostname, 'geocode.arcgis.com');
    assert.equal(url.searchParams.get('SingleLine'), address);
    return reply({ candidates });
  };
  assert.deepEqual(await geocode(address, fetcher), {
    lat: -27.466, lon: 153.0265, source: 'ArcGIS',
    matchedAddress: '157 Ann Street, Brisbane City',
  });
  assert.equal(requests.length, 2);
  await assert.rejects(geocode('157 Ann Street', async (url) =>
    url.hostname === 'nominatim.openstreetmap.org' ? reply([]) :
      reply({ candidates: [{ ...candidates[0], attributes: { Addr_type: 'StreetAddress', AddNum: '157' } }] })
  ), /Could not verify street number 157/);
  await assert.rejects(geocode('157 Ann Street', async (url) =>
    url.hostname === 'nominatim.openstreetmap.org' ? reply([]) :
      reply({ candidates: [{ ...candidates[0], attributes: { Addr_type: 'PointAddress', AddNum: '159' } }] })
  ), /Could not verify street number 157/);
  const missingOsm = await geocode('157 Ann Street', async (url) =>
    url.hostname === 'nominatim.openstreetmap.org' ? reply([]) : reply({ candidates }));
  assert.equal(missingOsm.source, 'ArcGIS');
});

test('login and session init use viewer parameters without leaking credentials to query', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('authenticate')) return reply({ data: { token } });
    if (String(url).includes('init')) return reply({ data: { session: 'SESSION' } });
    return reply({ features: [] });
  };
  const auth = await authenticate({ VEXCEL_EMAIL: 'user@example.org', VEXCEL_PASSWORD: 'secret' }, fetcher);
  assert.deepEqual(auth, { token, session: 'SESSION' });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    username: 'user@example.org', password: 'secret', application: 'anz',
  });
  const initBody = new URLSearchParams(calls[1].init.body);
  assert.equal(initBody.get('app'), 'viewer');
  assert.equal(initBody.get('hash')?.length, 64);
  assert.equal(calls[1].init.headers.Origin, 'https://anz-viewer.vexcelgroup.com');
  await queryPhotos({ lat: -27.47, lon: 153.02 }, auth, fetcher);
  const query = JSON.parse(calls[2].init.body);
  assert.equal(query.wkt, 'POINT(153.02 -27.47)');
  assert.equal(query.srid, '4326');
  assert.equal(query.layer, 'wide-area,urban');
  assert.equal(query['order-by'], 'image-center-distance-asc');
  assert.equal(new URL(calls[2].url).searchParams.get('session'), 'SESSION');
  assert.ok(!calls[2].init.body.includes('secret'));
  const bare = await authenticate({ VEXCEL_TOKEN: `https://api.vexcelgroup.com/x?token=${token}&other=1` },
    async (url) => { assert.match(String(url), /configuration\/init/); return reply({ session: null }); });
  assert.deepEqual(bare, { token, session: '' });
  await assert.rejects(authenticate({ VEXCEL_TOKEN: 'invalid' }, fetcher), /valid, unexpired JWT/);
});

test('the account-local login lets Node mint a token without embedded source credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vexcel-auth-'));
  try {
    const filename = path.join(root, 'vexcel-cli.json');
    await writeFile(filename, JSON.stringify({ email: 'owner@example.org', password: 'local-only' }),
      { mode: 0o600 });
    const env = await loadLocalAuth({}, filename);
    assert.deepEqual(env, { VEXCEL_EMAIL: 'owner@example.org', VEXCEL_PASSWORD: 'local-only' });
    const preferred = { VEXCEL_TOKEN: token };
    assert.equal(await loadLocalAuth(preferred, filename), preferred);
    assert.deepEqual(await loadLocalAuth({}, path.join(root, 'missing.json')), {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('prefer latest complete RGB collection; otherwise select newest per direction', () => {
  const complete = directions.map((d) => feature(d, 'old', '2024-01-01'));
  const partial = [feature('north', 'new', '2025-01-01')];
  const images = selectPhotos([...partial, ...complete, {
    properties: { ...feature('north', 'new').properties, 'image-name': 'new_north_irg' },
  }]);
  assert.deepEqual(Object.values(images).map((p) => p.collection), Array(4).fill('old'));
  const fallback = selectPhotos([...partial, ...complete.filter((f) => f.properties['product-type'] !== 'oblique-north')]);
  assert.equal(fallback.N.collection, 'new');
  assert.equal(fallback.E.collection, 'old');
  assert.throws(() => selectPhotos(partial), /E, S, W/);
  const withTop = selectPhotos([...complete, { properties: {
    ...feature('nadir', 'old', '2024-01-01').properties, 'product-type': 'nadir',
  } }]);
  assert.equal(withTop.Top.direction, 'Top');
  assert.equal(withTop.Top.collection, 'old');
});

test('downloads every tile with four concurrent workers, retries 429/truncated JPEG, and produces offline report', async () => {
  const photos = selectPhotos(directions.map((d) => feature(d, 'test', '2025-06-02', 257, 256)));
  let active = 0, maxActive = 0, calls = 0;
  const attempts = new Map();
  const fetcher = async (url, init) => {
    active++; maxActive = Math.max(active, maxActive); calls++;
    try {
      assert.equal(init.headers.Origin, 'https://anz-viewer.vexcelgroup.com');
      const params = new URL(url).searchParams;
      assert.equal(params.get('downsample'), '0');
      const name = params.get('image-name');
      const key = `${name}/${params.get('tile-x')}`;
      attempts.set(key, (attempts.get(key) || 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (key === 'test_north_rgb/0' && attempts.get(key) === 1) {
        return reply(null, 429);
      }
      if (key === 'test_east_rgb/0' && attempts.get(key) === 1) {
        return reply(Buffer.from([0xff, 0xd8]), 200, 'image/jpeg');
      }
      const edge = params.get('tile-x') === '1';
      return reply(tile(edge ? 1 : 256, 256), 200, 'image/jpeg');
    } finally { active--; }
  };
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'vexcel-tile-mock-'));
  let downloaded;
  try {
    downloaded = await downloadPhotos(photos, { token, session: 'SESSION' }, fetcher,
      { wait: async () => {}, cacheDir });
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
  assert.ok(maxActive >= 2 && maxActive <= 4, `network concurrency: ${maxActive}`);
  assert.equal(calls, 10);
  assert.equal(attempts.get('test_east_rgb/0'), 2);
  for (const dir of ['N', 'E', 'S', 'W']) assert.equal(downloaded[dir].tiles.length, 2);
  const html = buildReport('<Main & St>', { lat: 0, lon: 0 }, downloaded);
  assert.match(html, /&lt;Main &amp; St&gt;/);
  assert.equal((html.match(/data:image\/jpeg;base64,/g) || []).length, 8);
  assert.doesNotMatch(html, /SESSION|signature|api\.vexcelgroup\.com/);
  assert.deepEqual(tileLayout({ width: 5500, height: 3300 }).downsample, 2);
  await transformMarkers(downloaded, { lat: -27, lon: 153 }, { token, session: '' },
    async (url, init) => {
      assert.equal(new URL(url).searchParams.has('session'), false);
      assert.equal(JSON.parse(init.body).operation, 'world-2-pixel');
      return reply({ points: [{ location: { x: 12, y: 30 } }] });
    });
  assert.equal((buildReport('Address', { lat: -27, lon: 153 }, downloaded).match(/<circle /g) || []).length, 8);
});

test('max zoom chooses native pixels and crops around the projected house, not the photo centre', async () => {
  const layout = tileLayout({ width: 4096, height: 4096, direction: 'N',
    pixel: { x: 1700, y: 1200 } }, { maxZoom: true });
  assert.equal(layout.downsample, 0);
  assert.deepEqual([layout.width, layout.height, layout.left, layout.top], [1536, 1536, 932, 432]);
  assert.deepEqual(layout.tiles[0], { x: 3, y: 1 });
  assert.equal(layout.tiles.length, 49);
  assert.throws(() => tileLayout({ direction: 'S', width: 4000, height: 4000 },
    { maxZoom: true }), /Cannot locate the address/);
});

test('native capture transforms the address before fetching tiles and places its marker in the report', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vexcel-native-'));
  try {
    const output = path.join(root, 'house.html');
    let transformed = 0, tiles = 0;
    const fetcher = async (url) => {
      const u = String(url);
      if (u.includes('nominatim')) return reply([{ lat: '-26.688', lon: '153.041',
        address: { house_number: '34' }, display_name: '34 Cottman Street' }]);
      if (u.includes('configuration/init')) return reply({ session: 'SESSION' });
      if (u.includes('oriented/query')) return reply({ features: directions.map((d) =>
        feature(d, '2025', '2025-02-02', 256, 256)) });
      if (u.includes('transform-points')) { transformed++; return reply({ points: [{ x: 128, y: 128 }] }); }
      if (u.includes('oriented/tile')) {
        assert.equal(new URL(url).searchParams.get('downsample'), '0');
        assert.equal(transformed, 4, 'camera transform must finish before native tile requests');
        tiles++;
        return reply(tile(256, 256), 200, 'image/jpeg');
      }
      throw new Error('Unexpected request');
    };
    await capture('34 Cottman St', { env: { VEXCEL_TOKEN: token }, fetcher, output,
      maxZoom: true });
    assert.equal(tiles, 4);
    const html = await readFile(output, 'utf8');
    assert.match(html, /Native-resolution crop centred on the address/);
    assert.match(html, /<circle cx="128" cy="128"/);
    assert.match(html, /dialog class="viewer" id="result-modal"/);
    assert.doesNotMatch(html, /SESSION|signature|token=/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('full capture handles transform failure and never writes a partial report on missing tile', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vexcel-capture-'));
  try {
    const output = path.join(root, 'report.html');
    let matched;
    const fetcher = async (url, init) => {
      const u = String(url);
      if (u.includes('nominatim')) return reply([{ lat: '-27', lon: '153',
        address: { house_number: '1' }, display_name: '1 Test Street' }]);
      if (u.includes('configuration/init')) return reply({ session: 'SESSION' });
      if (u.includes('oriented/query')) return reply({ features: directions.map((d) => feature(d, '2025', '2025-01-02')) });
      if (u.includes('transform-points')) return reply(null, 404);
      if (u.includes('oriented/tile')) return reply(tile(), 200, 'image/jpeg');
      throw new Error('Unexpected request');
    };
    await capture('1 Test St', { env: { VEXCEL_TOKEN: token }, fetcher, output,
      onGeocode: (coords) => { matched = coords; } });
    assert.equal(matched.matchedAddress, '1 Test Street');
    const report = await readFile(output, 'utf8');
    assert.equal((report.match(/data:image\/jpeg;base64,/g) || []).length, 4);
    assert.match(report, /Captured 2025-01-02/);
    assert.match(report, /Matched address \(OpenStreetMap\): 1 Test Street/);
    assert.doesNotMatch(report, /SESSION|signature|token=/);
    const incomplete = async (url, init) => String(url).includes('oriented/tile')
      ? reply(Buffer.from([0xff, 0xd8]), 200, 'image/jpeg') : fetcher(url, init);
    const missing = path.join(root, 'missing.html');
    await assert.rejects(capture('1 Test St', { env: { VEXCEL_TOKEN: token }, fetcher: incomplete,
      output: missing, options: { wait: async () => {}, cacheDir: path.join(root, 'broken-cache') } }),
    /Incomplete [NESW] photo/);
    await assert.rejects(readFile(missing), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI arguments join positional address and require an output value', () => {
  assert.deepEqual(parseArgs(['--no-open', '--max-zoom', '12', 'Example', 'St', '--output', 'local.html']),
    { address: '12 Example St', output: 'local.html', open: false, maxZoom: true,
      previewLocation: false, coordinates: undefined, csv: undefined });
  assert.throws(() => parseArgs(['--output']), /requires a path/);
});

test('CLI coordinate flags require a finite WGS84 pair and accept signed bounds', () => {
  assert.deepEqual(parseArgs(['12', 'Example', 'St', '--lon', '180', '--lat', '-90',
    '--preview-location', '--no-open']), {
    address: '12 Example St', output: undefined, open: false, maxZoom: false,
    previewLocation: true, coordinates: { lat: -90, lon: 180 }, csv: undefined,
  });
  for (const args of [['--lat', '1'], ['--lon', '1']]) {
    assert.throws(() => parseArgs(['12 Example St', ...args]), /provided together/);
  }
  for (const args of [
    ['--lat', ''], ['--lon', ''], ['--lat', 'NaN'], ['--lon', 'Infinity'],
    ['--lat', '1e309'], ['--lat', '90.0001'], ['--lat', '-90.1'],
    ['--lon', '180.1'], ['--lon', '-180.1'], ['--lat', '0x10'],
  ]) {
    const pair = args[0] === '--lat' ? [...args, '--lon', '153'] : ['--lat', '-27', ...args];
    assert.throws(() => parseArgs(['12 Example St', ...pair]), /finite WGS84 coordinates/);
  }
  assert.throws(() => parseArgs(['12 Example St', '--lat', '--lon', '153']), /--lat requires/);
});

test('manual location bypasses geocoders, previews before image requests, and keeps the address in the report', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vexcel-manual-'));
  try {
    const address = '34 <Test & Lane>';
    const coordinates = { lat: -27.48123, lon: 153.01234 };
    const output = path.join(root, 'manual.html');
    const events = [];
    let selected;
    const fetcher = async (url, init) => {
      const u = String(url);
      assert.doesNotMatch(u, /nominatim|arcgis/, 'override must never call a geocoder');
      if (u.includes('configuration/init')) return reply({ session: 'SESSION' });
      if (u.includes('oriented/query')) {
        events.push('query');
        assert.equal(JSON.parse(init.body).wkt, 'POINT(153.01234 -27.48123)');
        return reply({ features: directions.map((d) => feature(d, '2025', '2025-02-02')) });
      }
      if (u.includes('oriented/tile')) {
        events.push('tile');
        return reply(tile(), 200, 'image/jpeg');
      }
      if (u.includes('transform-points')) {
        assert.equal(JSON.parse(init.body).wkt, 'POINT(153.01234 -27.48123)');
        return reply({ points: [{ x: 0, y: 0 }] });
      }
      throw new Error('Unexpected request');
    };
    await capture(address, { env: { VEXCEL_TOKEN: token }, fetcher, output, coordinates,
      onGeocode: (coords) => { selected = coords; events.push('location'); },
      previewLocation: true, openPreview: async (coords) => {
        assert.equal(coords, selected);
        events.push('preview');
      } });
    assert.deepEqual(events.slice(0, 3), ['location', 'preview', 'query']);
    assert.equal(events.filter((event) => event === 'tile').length, 4);
    assert.deepEqual(selected, { ...coordinates, source: 'Manual override', matchedAddress: address });
    assert.equal(formatLocationLog(selected),
      'Location via Manual override: 34 <Test & Lane> (-27.481230, 153.012340)');
    const html = await readFile(output, 'utf8');
    assert.match(html, /<title>Vexcel aerial views · 34 &lt;Test &amp; Lane&gt;<\/title>/);
    assert.match(html, /Location \(Manual override\): 34 &lt;Test &amp; Lane&gt;/);
    assert.match(html, /WGS84: -27\.481230, 153\.012340/);
    assert.doesNotMatch(html, /Matched address|Geocoding ©|SESSION|signature/);

    const other = path.join(root, 'without-preview.html');
    await capture(address, { env: { VEXCEL_TOKEN: token }, fetcher, output: other, coordinates,
      openPreview: () => { throw new Error('Browser preview opened without opt-in'); } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('programmatic overrides reject bad coordinates before any request or browser action', async () => {
  for (const coordinates of [
    { lat: 1 }, { lon: 1 }, { lat: 91, lon: 0 }, { lat: 0, lon: -181 },
    { lat: Number.POSITIVE_INFINITY, lon: 0 }, { lat: '', lon: 0 },
    { lat: null, lon: 0 }, { lat: 0, lon: Number.NaN },
  ]) {
    await assert.rejects(capture('1 Test St', { coordinates, previewLocation: true,
      fetcher: () => { throw new Error('Network request before validation'); },
      openPreview: () => { throw new Error('Browser opened before validation'); } }),
    /provided together|finite WGS84 coordinates/);
  }
});

test('location preview opens only a coordinate-only OpenStreetMap URL through the browser opener', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    return { status: 0 };
  };
  assert.equal(openLocationPreview({ lat: -27.48, lon: 153.02, source: 'Manual override',
    matchedAddress: 'Secret token=abc' }, { platform: 'win32', env: {}, run }), true);
  assert.deepEqual(calls.map(([command]) => command), ['rundll32.exe']);
  const url = new URL(calls[0][1][1]);
  assert.equal(url.origin, 'https://www.openstreetmap.org');
  assert.equal(url.searchParams.get('mlat'), '-27.48');
  assert.equal(url.searchParams.get('mlon'), '153.02');
  assert.equal(url.hash, '#map=18/-27.48/153.02');
  assert.doesNotMatch(url.href, /Secret|token|abc/);

  const wslCalls = [];
  assert.equal(openLocationPreview({ lat: 0, lon: 0 }, {
    platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' },
    run: (command, args) => {
      wslCalls.push([command, args]);
      return { status: command === 'rundll32.exe' ? 0 : 1 };
    },
  }), true);
  assert.deepEqual(wslCalls.map(([command]) => command), ['wslview', 'xdg-open', 'rundll32.exe']);
  assert.equal(wslCalls[2][1][1], 'https://www.openstreetmap.org/?mlat=0&mlon=0#map=18/0/0');
});

test('WSL browser fallback converts a local path without shell interpretation', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === 'wslpath') return { status: 0, stdout: 'C:\\Users\\Me\\my report.html\n' };
    return { status: command === 'rundll32.exe' ? 0 : 1 };
  };
  assert.equal(openReport('/mnt/c/Users/Me/my report.html', {
    platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, run,
  }), true);
  assert.deepEqual(calls.map(([command]) => command), ['wslview', 'xdg-open', 'wslpath', 'rundll32.exe']);
  assert.deepEqual(calls[3][1], ['url.dll,FileProtocolHandler', 'file:///C:/Users/Me/my%20report.html']);
});
