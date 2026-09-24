import test from 'node:test';
import assert from 'node:assert/strict';
import { lightPollutionToken } from '../src/utils/lightpoll-token.js';
import { LightPollutionLayerProvider } from '../src/providers/light-pollution.js';

test('public WMS token embeds a changing timestamp and the published hash', () => {
  assert.equal(atob(lightPollutionToken(1_790_245_220_000)),
    '1790245220.971c8ccc11150435bc555a975751b909');
  assert.notEqual(lightPollutionToken(1_790_245_220_000), lightPollutionToken(1_790_245_221_000));
});

test('light-pollution 2D and 3D URLs use tokenized public proxy', () => {
  globalThis.L = { TileLayer: { extend: (o) => class {
    constructor(_url, opts) { this.options = opts; this.getTileUrl = o.getTileUrl; }
    on() { return this; }
  } } };
  const layer = new LightPollutionLayerProvider().create();
  const url = layer.getTileUrl({ z: 10, x: 947, y: 593 });
  assert.match(url, /^https:\/\/www\.lightpollutionmap\.info\/tiles\/wms\?/);
  assert.equal(atob(new URL(url).searchParams.get('token')).split('.')[1], '971c8ccc11150435bc555a975751b909');
  assert.match(layer._dwMb3DUrl, /&BBOX=\{bbox-epsg-3857\}&token=/);
  assert.deepEqual(layer._dwMb3DReloadOn, ['lightpolltokenrefresh']);
});
