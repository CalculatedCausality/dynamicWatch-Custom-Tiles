#!/usr/bin/env node
// Standalone Vexcel ANZ viewer capture. No userscript state or bundled credentials.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { VEXCEL_DIRECTIONS, _vexcelCollectionYear, vexcelOrientedQueryBody, vexcelPointWkt } from '../src/providers/vexcel-protocol.js';
import { requestJson, requestBytes } from './vexcel-http.mjs';
import { downloadTileBatch, jpegSize, validJpeg } from './vexcel-tile-batch.mjs';
import { buildReport } from './vexcel-report.mjs';
import { pruneTileCache } from './vexcel-cache.mjs';
import { parseAddressCsv } from './vexcel-csv.mjs';
export { buildReport } from './vexcel-report.mjs';

const API = 'https://api.vexcelgroup.com';
const ADMIN = 'https://admin.vexcelgroup.com';
const ORIGIN = 'https://anz-viewer.vexcelgroup.com';
const LOCAL_AUTH = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'),
  'dynamicwatch-custom-tiles', 'vexcel-cli.json');
const USER_AGENT = 'dynamicwatch-vexcel-capture/1.0 (https://github.com/CalculatedCausality/dynamicWatch-Custom-Tiles; Nominatim address lookup)';
const DIRECTIONS = VEXCEL_DIRECTIONS.map(({ label, key }) => [label, key]);
const viewerHeaders = { Origin: ORIGIN, Referer: `${ORIGIN}/`, 'X-App-Key': 'viewer-app' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseToken(raw) {
  const s = String(raw || '').trim();
  const match = s.match(/(?:^|[?&#\s])token=([\w-]+\.[\w-]+\.[\w-]+)/) ||
    s.match(/^([\w-]+\.[\w-]+\.[\w-]+)$/);
  return match?.[1] || '';
}

function validToken(token) {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp;
    return Number.isFinite(exp) && exp * 1000 > Date.now() + 60_000;
  } catch { return false; }
}

export async function geocode(address, fetcher = fetch, options = {}) {
  // Ignore an optional unit number (2/157) and look for the civic street
  // number. Split at commas so "Unit 2, 157 Ann St" does not resolve as 2.
  const requestedNumber = address.split(',').map((part) =>
    part.trim().match(/^(?:(?:unit|flat|apartment|suite|shop)\s+[\w-]+\s*\/\s*|\d+\s*\/\s*)?(\d+[a-z]?(?:-\d+[a-z]?)?)\s+\S+/i)?.[1]
  ).find(Boolean) || '';
  const sameNumber = (number) => String(number || '').replace(/\s+/g, '').toLowerCase() ===
    requestedNumber.replace(/\s+/g, '').toLowerCase();
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ q: address, format: 'jsonv2', addressdetails: '1', limit: '1' }).toString();
  // One request only: do not retry Nominatim, including on server errors.
  let data;
  try {
    data = await requestJson(fetcher, url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    }, { ...options, retries: 0 });
  } catch { /* Fall back to the address-level ArcGIS geocoder. */ }
  if (Array.isArray(data) && data.length) {
    const first = data[0];
    const lat = Number(first.lat), lon = Number(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
        lat < -90 || lat > 90 || lon < -180 || lon > 180 ||
        first.lat == null || first.lon == null ||
        String(first.lat).trim() === '' || String(first.lon).trim() === '') {
      throw new Error('Nominatim returned invalid WGS84 coordinates');
    }
    if (!requestedNumber || sameNumber(first.address?.house_number)) {
      return { lat, lon, source: 'OpenStreetMap', matchedAddress: first.display_name || address };
    }
  }

  const fallback = new URL('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates');
  fallback.search = new URLSearchParams({ SingleLine: address, f: 'json',
    outFields: 'Addr_type,Match_addr,Score,AddNum', maxLocations: '5' }).toString();
  let esri;
  try {
    esri = await requestJson(fetcher, fallback, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    }, { ...options, retries: 0 });
  } catch { throw new Error('Address lookup failed at both OpenStreetMap and ArcGIS'); }
  const candidate = (esri?.candidates || []).find((item) => {
    const attrs = item.attributes || {};
    return Number(item.score) >= 90 &&
      (!requestedNumber || (['PointAddress', 'Subaddress'].includes(attrs.Addr_type) &&
        sameNumber(attrs.AddNum)));
  });
  const lat = Number(candidate?.location?.y), lon = Number(candidate?.location?.x);
  if (!candidate || !Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error(requestedNumber
      ? `Could not verify street number ${requestedNumber} for that address in either geocoder`
      : 'Address not found by OpenStreetMap or ArcGIS');
  }
  return { lat, lon, source: 'ArcGIS', matchedAddress: candidate.address || address };
}

export async function authenticate(env, fetcher = fetch, options = {}) {
  let token;
  if (env.VEXCEL_TOKEN) {
    token = parseToken(env.VEXCEL_TOKEN);
    if (!validToken(token)) throw new Error('VEXCEL_TOKEN must contain a valid, unexpired JWT');
  } else {
    if (!env.VEXCEL_EMAIL || !env.VEXCEL_PASSWORD) {
      throw new Error('Set VEXCEL_TOKEN or both VEXCEL_EMAIL and VEXCEL_PASSWORD');
    }
    const data = await requestJson(fetcher, `${ADMIN}/api/auth/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Key': 'viewer-app' },
      body: JSON.stringify({ username: env.VEXCEL_EMAIL, password: env.VEXCEL_PASSWORD, application: 'anz' }),
    }, options);
    token = data?.data?.token;
    if (!validToken(token)) throw new Error('Vexcel login did not return a valid JWT');
  }
  const timestamp = Date.now();
  const hash = createHash('sha256').update(`viewer_${timestamp}`).digest('hex');
  const init = new URL(`${ADMIN}/api/viewer/configuration/init`);
  init.searchParams.set('token', token);
  const data = await requestJson(fetcher, init, {
    method: 'POST', headers: { ...viewerHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ hash, timestamp: String(timestamp), app: 'viewer' }).toString(),
  }, options);
  const session = data?.session || data?.data?.session || '';
  if (session && typeof session !== 'string') throw new Error('Vexcel session init returned an invalid session');
  return { token, session };
}

// This account-local config lives outside the repository. Existing environment
// credentials take precedence; browser/Tampermonkey GM storage is not accessible to Node.
export async function loadLocalAuth(env = process.env, filename = LOCAL_AUTH) {
  if (env.VEXCEL_TOKEN || (env.VEXCEL_EMAIL && env.VEXCEL_PASSWORD)) return env;
  let local;
  try { local = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return env;
    throw new Error('Could not read the local Vexcel login file');
  }
  if (!local || typeof local.email !== 'string' || typeof local.password !== 'string') {
    throw new Error('The local Vexcel login file needs email and password fields');
  }
  return { ...env, VEXCEL_EMAIL: local.email, VEXCEL_PASSWORD: local.password };
}

function authUrl(endpoint, auth) {
  const url = new URL(`${API}/v2/oriented/${endpoint}`);
  if (auth.session) url.searchParams.set('session', auth.session);
  url.searchParams.set('token', auth.token);
  return url;
}

export async function queryPhotos(coords, auth, fetcher = fetch, options = {}) {
  const body = vexcelOrientedQueryBody(coords.lat, coords.lon);
  const data = await requestJson(fetcher, authUrl('query', auth), {
    method: 'POST', headers: { ...viewerHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, options);
  if (!Array.isArray(data?.features)) throw new Error('Vexcel oriented query returned no feature list');
  return data.features;
}

function captureDate(p) {
  const date = String(p['capture-date'] || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return _vexcelCollectionYear(p.collection) || 'Unknown';
}

export function selectPhotos(features) {
  const collections = new Map();
  for (const feature of features) {
    const p = feature?.properties || {};
    const dir = DIRECTIONS.find(([, key]) => key === p['product-type'])?.[0];
    const w = Number(p['raster-size-width']), h = Number(p['raster-size-height']);
    if (!dir || !p.collection || !/_rgb$/i.test(String(p['image-name'] || '')) ||
        !Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) continue;
    const date = captureDate(p);
    if (!collections.has(p.collection)) collections.set(p.collection, { date, photos: {} });
    const entry = collections.get(p.collection);
    if (date > entry.date) entry.date = date;
    // Query is ordered nearest image centre first; retain the first RGB frame per cell.
    entry.photos[dir] ||= {
      direction: dir, name: p['image-name'], layer: p['source-layer'] || p.layer || 'urban',
      width: w, height: h, date, collection: p.collection,
    };
  }
  const ordered = [...collections.values()].sort((a, b) =>
    (b.date === 'Unknown' ? '' : b.date).localeCompare(a.date === 'Unknown' ? '' : a.date));
  const compass = DIRECTIONS.filter(([dir]) => dir !== 'Top');
  const complete = ordered.find((c) => compass.every(([dir]) => c.photos[dir]));
  const photos = Object.fromEntries(compass.map(([dir]) =>
    [dir, complete?.photos[dir] || ordered.find((c) => c.photos[dir])?.photos[dir]]));
  const top = complete?.photos.Top || ordered.find((c) => c.photos.Top)?.photos.Top;
  if (top) photos.Top = top;
  const missing = compass.filter(([dir]) => !photos[dir]).map(([dir]) => dir);
  if (missing.length) throw new Error(`No RGB Vexcel oblique photo for: ${missing.join(', ')}`);
  return photos;
}

export function tileLayout(photo, { maxZoom = false } = {}) {
  // Normal reports fit the whole photo; house reports use native pixels from
  // a 1536 px crop around the camera-projected address point.
  if (maxZoom && (!Number.isFinite(photo.pixel?.x) || !Number.isFinite(photo.pixel?.y))) {
    throw new Error(`Cannot locate the address in the ${photo.direction} photograph at native resolution`);
  }
  const downsample = maxZoom ? 0 : Math.max(0,
    Math.ceil(Math.log2(Math.max(photo.width, photo.height) / 1600)));
  const scale = 2 ** downsample;
  const fullWidth = Math.ceil(photo.width / scale), fullHeight = Math.ceil(photo.height / scale);
  const width = maxZoom ? Math.min(1536, fullWidth) : fullWidth;
  const height = maxZoom ? Math.min(1536, fullHeight) : fullHeight;
  const left = maxZoom ? Math.max(0, Math.min(fullWidth - width, Math.floor(photo.pixel.x - width / 2))) : 0;
  const top = maxZoom ? Math.max(0, Math.min(fullHeight - height, Math.floor(photo.pixel.y - height / 2))) : 0;
  const tiles = [];
  for (let y = Math.floor(top / 256); y <= Math.floor((top + height - 1) / 256); y++) {
    for (let x = Math.floor(left / 256); x <= Math.floor((left + width - 1) / 256); x++) {
      tiles.push({ x, y });
    }
  }
  return { downsample, width, height, left, top, fullWidth, fullHeight, maxZoom, tiles };
}

export async function downloadPhotos(photos, auth, fetcher = fetch, options = {}, maxZoom = false) {
  const jobs = [];
  const result = {};
  for (const [dir] of DIRECTIONS.filter(([label]) => photos[label])) {
    const photo = photos[dir], layout = tileLayout(photo, { maxZoom });
    result[dir] = { ...photo, ...layout, expectedTiles: layout.tiles.length,
      tiles: new Array(layout.tiles.length) };
    if (photo.pixel) result[dir].marker = {
      x: photo.pixel.x / (2 ** layout.downsample) - layout.left,
      y: photo.pixel.y / (2 ** layout.downsample) - layout.top,
    };
    for (const [index, tile] of layout.tiles.entries()) jobs.push({ dir, photo, layout, tile, index });
  }
  const tileJobs = jobs.map(({ dir, photo, layout, tile }) => ({
    dir, imageName: photo.name, layer: photo.layer, downsample: layout.downsample,
    x: tile.x, y: tile.y,
    expectedWidth: Math.min(256, layout.fullWidth - tile.x * 256),
    expectedHeight: Math.min(256, layout.fullHeight - tile.y * 256),
  }));
  const buffers = await downloadTileBatch(tileJobs, {
    cacheDir: options.cacheDir || path.resolve('captures/.vexcel-tile-cache'),
    concurrency: 4,
    signal: options.signal,
    onProgress: options.onProgress,
    fetchTile: async (job, { signal }) => {
      const url = authUrl('tile', auth);
      for (const [key, value] of Object.entries({ layer: job.layer, 'image-name': job.imageName,
        downsample: job.downsample, 'tile-x': job.x, 'tile-y': job.y })) {
        url.searchParams.set(key, value);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        let bytes;
        try {
          bytes = await requestBytes(fetcher, url, {
            headers: { ...viewerHeaders, Accept: 'image/jpeg,image/*,*/*;q=0.8' },
          }, { ...options, signal });
        } catch (error) {
          if (signal.aborted) throw error;
          throw new Error(`Could not download ${job.dir} tile ${job.x},${job.y}`);
        }
        if (validJpeg(bytes, job)) return bytes;
        if (attempt < 2) await (options.wait || sleep)(200 * 2 ** attempt, signal);
      }
      throw new Error(`Incomplete ${job.dir} photo (tile ${job.x},${job.y})`);
    },
  });
  buffers.forEach((bytes, i) => {
    const { dir, tile, index } = jobs[i];
    result[dir].tiles[index] = { ...tile, ...jpegSize(bytes), data: bytes.toString('base64') };
  });
  return result;
}

export async function transformMarkers(photos, coords, auth, fetcher = fetch, options = {}) {
  await Promise.all(DIRECTIONS.filter(([label]) => photos[label]).map(async ([dir]) => {
    const photo = photos[dir];
    try {
      const data = await requestJson(fetcher, authUrl('transform-points', auth), {
        method: 'POST', headers: { ...viewerHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'world-2-pixel', 'image-name': photo.name,
          wkt: vexcelPointWkt(coords.lon, coords.lat), srid: 4326, 'metadata-format': 'json' }),
      }, { ...options, retries: 0 });
      const point = data?.points?.[0];
      const value = point?.x != null && point?.y != null ? point : point?.location;
      const x = Number(value?.x), y = Number(value?.y);
      if (value?.x != null && value?.y != null && Number.isFinite(x) && Number.isFinite(y) &&
          x >= 0 && x < photo.width && y >= 0 && y < photo.height) {
        photo.pixel = { x, y };
        if (photo.downsample != null) photo.marker = {
          x: x / (2 ** photo.downsample) - photo.left,
          y: y / (2 ** photo.downsample) - photo.top,
        };
      }
    } catch { /* A missing camera transform must not discard the photograph. */ }
  }));
}

function overrideCoordinates(coordinates, address) {
  if (coordinates == null) return null;
  const { lat, lon } = coordinates;
  if ((lat === undefined) !== (lon === undefined)) throw new Error('--lat and --lon must be provided together');
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const valid = (value, min, max) => (typeof value === 'string' || typeof value === 'number') &&
    numeric.test(String(value).trim()) && Number.isFinite(Number(value)) &&
    Number(value) >= min && Number(value) <= max;
  if (!valid(lat, -90, 90) || !valid(lon, -180, 180)) {
    throw new Error('--lat and --lon require finite WGS84 coordinates (latitude -90..90, longitude -180..180)');
  }
  return { lat: Number(lat), lon: Number(lon), source: 'Manual override', matchedAddress: address };
}

export async function capture(address, { env = process.env, fetcher = fetch, output,
  options = {}, onGeocode, maxZoom = false, coordinates, previewLocation = false,
  openPreview = openLocationPreview } = {}) {
  if (!address?.trim()) throw new Error('Enter a street address');
  const coords = overrideCoordinates(coordinates, address) || await geocode(address, fetcher, options);
  onGeocode?.(coords);
  if (previewLocation) await openPreview(coords);
  const auth = await authenticate(env, fetcher, options);
  const selected = selectPhotos(await queryPhotos(coords, auth, fetcher, options));
  if (maxZoom) await transformMarkers(selected, coords, auth, fetcher, options);
  const destination = path.resolve(output || path.join('captures', `vexcel-${Date.now()}.html`));
  const cacheDir = options.cacheDir || path.join(path.dirname(destination), '.vexcel-tile-cache');
  await pruneTileCache(cacheDir);
  const photos = await downloadPhotos(selected, auth, fetcher, {
    ...options, cacheDir,
  }, maxZoom);
  if (!maxZoom) await transformMarkers(photos, coords, auth, fetcher, options);
  const html = buildReport(address, coords, photos);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, html, { mode: 0o600 });
  return destination;
}

export async function captureCsv(csvPath, { output, env = process.env, fetcher = fetch,
  maxZoom = false, delay = sleep, onGeocode } = {}) {
  const rows = parseAddressCsv(await readFile(csvPath, 'utf8'));
  const folder = path.resolve(output || path.join('captures', `batch-${Date.now()}`));
  await mkdir(folder, { recursive: true });
  const results = [];
  let lastLookup = false;
  for (const [index, { address, coordinates }] of rows.entries()) {
    // Public Nominatim allows one lookup per second. ArcGIS-only rows also
    // start with Nominatim; manually supplied points skip the lookup.
    if (!coordinates && lastLookup) await delay(1100);
    lastLookup = !coordinates;
    const name = address.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 70) || 'address';
    const filename = `${String(index + 1).padStart(3, '0')}-${name}.html`;
    try {
      await capture(address, { env, fetcher, maxZoom, coordinates,
        output: path.join(folder, filename), onGeocode });
      results.push({ address, filename });
    } catch (error) {
      results.push({ address, error: error.message });
    }
  }
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const entries = results.map(({ address, filename, error }) => `<li>${filename
    ? `<a href="${encodeURIComponent(filename)}">${escape(address)}</a>`
    : `${escape(address)} — ${escape(error)}`}</li>`).join('\n');
  const indexPath = path.join(folder, 'index.html');
  await writeFile(indexPath, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Vexcel capture batch</title><main><h1>Vexcel capture batch</h1><p>Imagery © Vexcel Imaging</p><ol>${entries}</ol></main></html>`,
    { mode: 0o600 });
  return { indexPath, completed: results.filter((r) => r.filename).length,
    failed: results.filter((r) => r.error).length };
}

export function parseArgs(args) {
  let output, open = true, maxZoom = false, previewLocation = false, lat, lon, csv;
  const address = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-open') open = false;
    else if (arg === '--max-zoom') maxZoom = true;
    else if (arg === '--preview-location') previewLocation = true;
    else if (arg === '--csv') {
      csv = args[++i];
      if (!csv || csv.startsWith('--')) throw new Error('--csv requires a file');
    }
    else if (arg === '--lat' || arg === '--lon') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a coordinate`);
      if (arg === '--lat') lat = value;
      else lon = value;
    }
    else if (arg === '--output') {
      output = args[++i];
      if (!output || output.startsWith('--')) throw new Error('--output requires a path');
    } else if (arg.startsWith('--')) throw new Error('Unknown option');
    else address.push(arg);
  }
  if ((lat === undefined) !== (lon === undefined)) throw new Error('--lat and --lon must be provided together');
  const name = address.join(' ').trim();
  if (csv && (name || lat !== undefined || previewLocation)) {
    throw new Error('--csv accepts only --output, --max-zoom and --no-open');
  }
  const coordinates = lat === undefined ? undefined : overrideCoordinates({ lat, lon }, name);
  return { address: name, csv, output, open, maxZoom, previewLocation,
    coordinates: coordinates && { lat: coordinates.lat, lon: coordinates.lon } };
}

export function openReport(destination, { platform = process.platform, env = process.env, run = spawnSync } = {}) {
  const remote = destination instanceof URL;
  const target = remote ? destination.href : destination;
  const wsl = env.WSL_DISTRO_NAME || env.WSL_INTEROP;
  const commands = platform === 'win32' ?
    [['rundll32.exe', ['url.dll,FileProtocolHandler', remote ? target : pathToFileURL(target).href]]] :
    platform === 'darwin' ? [['open', [target]]] :
    [...(wsl ? [['wslview', [target]]] : []), ['xdg-open', [target]]];
  for (const [command, args] of commands) {
    const result = run(command, args, { stdio: 'ignore', timeout: 8000 });
    if (!result.error && result.status === 0) return true;
  }
  if (remote && wsl && platform === 'linux') {
    const result = run('rundll32.exe', ['url.dll,FileProtocolHandler', target],
      { stdio: 'ignore', timeout: 8000 });
    return !result.error && result.status === 0;
  }
  if (!remote && wsl && platform === 'linux') {
    const converted = run('wslpath', ['-w', destination], { encoding: 'utf8', timeout: 8000 });
    if (!converted.error && converted.status === 0 && converted.stdout?.trim()) {
      const winPath = converted.stdout.trim().replace(/\\/g, '/');
      const url = `file:///${winPath.split('/').map((part, index) =>
        index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join('/')}`;
      const result = run('rundll32.exe', ['url.dll,FileProtocolHandler', url],
        { stdio: 'ignore', timeout: 8000 });
      if (!result.error && result.status === 0) return true;
    }
  }
  return false;
}

export function openLocationPreview(coords, options) {
  const url = new URL('https://www.openstreetmap.org/');
  url.searchParams.set('mlat', String(coords.lat));
  url.searchParams.set('mlon', String(coords.lon));
  url.hash = `map=18/${coords.lat}/${coords.lon}`;
  return openReport(url, options);
}

export function formatLocationLog(coords) {
  return `${coords.source === 'Manual override' ? 'Location' : 'Matched'} via ${coords.source}: ${coords.matchedAddress} (${coords.lat.toFixed(6)}, ${coords.lon.toFixed(6)})`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.csv) {
    const result = await captureCsv(args.csv, { output: args.output, maxZoom: args.maxZoom,
      env: await loadLocalAuth(), onGeocode: (coords) => console.log(formatLocationLog(coords)) });
    console.log(`Captured ${result.completed} address(es), ${result.failed} failed: ${result.indexPath}`);
    if (args.open && !openReport(result.indexPath)) console.log('Open the batch index manually.');
    if (result.failed) process.exitCode = 1;
    return;
  }
  if (!args.address) {
    if (!process.stdin.isTTY) throw new Error('Pass a street address or run interactively');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { args.address = (await rl.question('Street address: ')).trim(); }
    finally { rl.close(); }
  }
  const destination = await capture(args.address, { output: args.output, maxZoom: args.maxZoom,
    coordinates: args.coordinates, previewLocation: args.previewLocation,
    openPreview: (coords) => {
      if (!openLocationPreview(coords)) console.log('No browser opener available for the location preview.');
    },
    env: await loadLocalAuth(),
    onGeocode: (coords) => console.log(formatLocationLog(coords)),
  });
  console.log(`Saved ${destination}`);
  if (args.open && !openReport(destination)) console.log('No browser opener available; open the saved file manually.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Vexcel capture: ${error.message}`); process.exitCode = 1; });
}
