import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _vexcelBand, _vexcelCollectionYear, VEXCEL_DIRECTIONS,
  vexcelFrameQueryBody, vexcelOrientedQueryBody, vexcelPointWkt,
} from '../src/providers/vexcel-protocol.js';
import { buildReport } from '../scripts/vexcel-report.mjs';

test('neutral oriented protocol preserves compass order, bands and capture years', () => {
  assert.deepEqual(VEXCEL_DIRECTIONS.map(({ label, key }) => [label, key]), [
    ['N', 'oblique-north'], ['E', 'oblique-east'], ['S', 'oblique-south'],
    ['W', 'oblique-west'], ['Top', 'nadir'],
  ]);
  assert.equal(_vexcelBand('frame_IRG'), 'irg');
  assert.equal(_vexcelBand('frame_rgb'), 'rgb');
  assert.equal(_vexcelCollectionYear('au-qld-2019-r2-2021'), '2021');
  assert.equal(_vexcelCollectionYear('unknown'), 'unknown');
});

test('oriented query body retains the full capture fields and nearest-frame ordering', () => {
  assert.equal(vexcelPointWkt('153.02', '-27.47'), 'POINT(153.02 -27.47)');
  const all = vexcelOrientedQueryBody(-27.47, 153.02);
  assert.deepEqual(all, {
    wkt: 'POINT(153.02 -27.47)', srid: '4326', layer: 'wide-area,urban',
    'order-by': 'image-center-distance-asc',
    include: 'collection,capture-date,product-type,image-name,source-layer,' +
      'raster-size-width,raster-size-height,geometry',
  });
  assert.deepEqual(vexcelFrameQueryBody('153.02', '-27.47', 'qld-2025', 'oblique-west', 'irg'), {
    wkt: all.wkt, srid: '4326', layer: 'wide-area,urban',
    'product-type': 'oblique-west', bands: 'irg',
    'order-by': 'image-center-distance-asc', 'total-records': 1,
    include: 'image-name,source-layer,raster-size-width,raster-size-height,geometry',
    collection: 'qld-2025',
  });
  const unfiltered = vexcelFrameQueryBody(153.02, -27.47, '', 'oblique-north');
  assert.equal(unfiltered.bands, 'rgb');
  assert.equal('collection' in unfiltered, false);
  assert.equal('collection' in all, false);
});

const coords = { lat: -27.47, lon: 153.02, source: 'ArcGIS', matchedAddress: '1 <Main> & "St"' };
function photos(maxZoom = false) {
  return Object.fromEntries(['N', 'E', 'S', 'W'].map((dir, index) => [dir, {
    width: 512, height: 384, left: 256, top: 0, expectedTiles: 1, maxZoom,
    date: index === 0 ? '<img src=x onerror=alert(1)>' : '2025-01-01',
    tiles: [{ x: 1, y: 0, width: 256, height: 256, data: 'AAAA' }],
    marker: index === 0 ? { x: 12, y: 34 } : undefined,
  }]));
}

test('offline report escapes external labels and locates a cropped tile and marker', () => {
  const html = buildReport('1 <Main> & "St"', coords, photos());
  assert.match(html, /<title>Vexcel aerial views · 1 &lt;Main&gt; &amp; &quot;St&quot;<\/title>/);
  assert.match(html, /Matched address \(ArcGIS\): 1 &lt;Main&gt; &amp; &quot;St&quot;/);
  assert.match(html, /Captured &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x|<Main>/);
  assert.match(html, /<image x="0" y="0" width="256" height="256" href="data:image\/jpeg;base64,AAAA"\/>/);
  assert.match(html, /<circle cx="12" cy="34"/);
  assert.deepEqual([...html.matchAll(/<figure data-direction="([NESW])"/g)].map((match) => match[1]),
    ['N', 'E', 'S', 'W']);
  assert.match(html, /Imagery © Vexcel Imaging · Geocoding © Esri and its data providers/);
  assert.match(html, /let direction = 'N', actual = false;/);
  assert.match(html, /show\('N'\);/);
  assert.deepEqual([...html.matchAll(/data-action="([NESW])"/g)].map((match) => match[1]),
    ['N', 'E', 'S', 'W']);
  assert.match(html, /data-action="fit"/);
  assert.match(html, /data-action="actual"/);
});

test('native report opens at 1:1 and refuses incomplete photos before rendering', () => {
  const native = buildReport('Address', { ...coords, source: 'OpenStreetMap' }, photos(true));
  assert.match(native, /let direction = 'N', actual = true;/);
  assert.match(native, /Native-resolution crop centred on the address/);
  assert.match(native, /Geocoding © OpenStreetMap contributors/);
  const incomplete = photos();
  incomplete.E.tiles[0].data = '';
  assert.throws(() => buildReport('Address', coords, incomplete), /Incomplete E photo/);
  incomplete.E = photos().E;
  delete incomplete.W;
  assert.throws(() => buildReport('Address', coords, incomplete), /Incomplete W photo/);
});
