import { VEXCEL_DIRECTIONS } from '../src/providers/vexcel-protocol.js';

const DIRECTIONS = VEXCEL_DIRECTIONS.map(({ label, key }) => [label, key]);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function buildReport(address, coords, photos) {
  for (const [dir] of DIRECTIONS.filter(([label]) => label !== 'Top')) {
    if (!photos[dir]) throw new Error(`Incomplete ${dir} photo`);
  }
  const cards = DIRECTIONS.filter(([dir]) => photos[dir]).map(([dir, key]) => {
    const p = photos[dir];
    if (!p || p.tiles.length !== p.expectedTiles ||
        p.tiles.some((t) => !t?.data)) {
      throw new Error(`Incomplete ${dir} photo`);
    }
    const tiles = p.tiles.map((tile) => {
      const x = tile.x * 256 - p.left, y = tile.y * 256 - p.top;
      return `<image x="${x}" y="${y}" width="${tile.width}" height="${tile.height}" href="data:image/jpeg;base64,${tile.data}"/>`;
    }).join('');
    const marker = p.marker ? `<circle cx="${p.marker.x}" cy="${p.marker.y}" r="9" fill="#ffce39" stroke="#111" stroke-width="3"/><circle cx="${p.marker.x}" cy="${p.marker.y}" r="2" fill="#111"/>` : '';
    return `<figure data-direction="${dir}"><svg viewBox="0 0 ${p.width} ${p.height}" role="img" aria-label="${dir === 'Top' ? 'top-down' : dir + ' oblique'} photograph" xmlns="http://www.w3.org/2000/svg">${tiles}${marker}</svg><figcaption><strong>${dir} · ${escapeHtml(dir === 'Top' ? 'straight down' : key.replace('oblique-', ''))}</strong> <span>Captured ${escapeHtml(p.date)} · © Vexcel Imaging</span><button type="button" class="inspect" data-direction="${dir}">Inspect at 1:1</button></figcaption></figure>`;
  }).join('\n');
  const match = coords.source === 'Manual override'
    ? `<p>Location (${escapeHtml(coords.source)}): ${escapeHtml(address)}</p>`
    : coords.matchedAddress
      ? `<p>Matched address (${escapeHtml(coords.source)}): ${escapeHtml(coords.matchedAddress)}</p>` : '';
  const geocoderCredit = coords.source === 'ArcGIS' ? 'Esri and its data providers' : 'OpenStreetMap contributors';
  const credit = coords.source === 'Manual override' ? '' : ` · Geocoding © ${geocoderCredit}`;
  const native = Object.values(photos).every((p) => p.maxZoom);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vexcel aerial views · ${escapeHtml(address)}</title><style>
body{margin:0;background:#101820;color:#f5f7f8;font:16px system-ui,sans-serif}main{max-width:1300px;margin:auto;padding:1.5rem}h1{font-size:clamp(1.5rem,4vw,2.5rem)}p{color:#c3ced6}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,500px),1fr));gap:1.3rem}figure{margin:0;background:#23313d;border-radius:10px;overflow:hidden}figure>svg{display:block;width:100%;height:auto;background:#192630}figcaption{padding:1rem;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}figcaption span{color:#c3ced6}button{cursor:pointer;border:1px solid #a9c2d7;border-radius:5px;background:#283f54;color:#fff;padding:.5rem .8rem}button:hover,button:focus-visible{background:#426687}.viewer{box-sizing:border-box;border:1px solid #7790a5;border-radius:8px;background:#101820;color:#fff;width:min(96vw,1500px);max-width:none;height:94vh;max-height:none;padding:1rem}.viewer::backdrop{background:rgba(0,0,0,.8)}.toolbar{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.75rem}.toolbar strong{margin-right:auto}.viewport{width:100%;height:calc(100% - 4rem);overflow:auto;background:#111}.viewport svg{display:block;max-width:none;height:auto}.viewport svg.fit{width:100%}
  </style></head><body><main><h1>${escapeHtml(address)}</h1>${match}<p>WGS84: ${coords.lat.toFixed(6)}, ${coords.lon.toFixed(6)} · Four cardinal obliques${photos.Top ? ' + straight-down view' : ''} · ${native ? 'Native-resolution crop centred on the address' : 'Full-frame preview'} · Imagery © Vexcel Imaging${credit}</p><div class="grid">${cards}</div></main>
  <dialog class="viewer" id="result-modal" data-filename="${escapeHtml(address.replace(/[^a-z0-9]+/gi, '-').slice(0, 60) || 'vexcel')}" aria-label="Vexcel photo viewer"><div class="toolbar"><strong id="viewer-title">Vexcel aerial view</strong><button type="button" data-action="N">N</button><button type="button" data-action="E">E</button><button type="button" data-action="S">S</button><button type="button" data-action="W">W</button>${photos.Top ? '<button type="button" data-action="Top">Top</button>' : ''}<button type="button" data-action="fit">Fit</button><button type="button" data-action="actual">1:1 pixels</button><button type="button" data-action="save">Save image</button><button type="button" data-action="close">Close</button></div><div class="viewport" id="viewer-viewport"></div></dialog>
  <script>
  (() => {
    const dialog = document.getElementById('result-modal');
    const viewport = document.getElementById('viewer-viewport');
    const title = document.getElementById('viewer-title');
    let direction = 'N', actual = ${native ? 'true' : 'false'};
    const show = (dir) => {
      const photo = document.querySelector('figure[data-direction="' + dir + '"]');
      if (!photo) return;
      direction = dir;
      const svg = photo.querySelector('svg').cloneNode(true);
      viewport.replaceChildren(svg);
      title.textContent = dir + ' · ' + photo.querySelector('figcaption span').textContent;
      svg.classList.toggle('fit', !actual);
      if (actual) {
        svg.style.width = svg.viewBox.baseVal.width + 'px';
        svg.style.height = svg.viewBox.baseVal.height + 'px';
        const marker = svg.querySelector('circle');
        requestAnimationFrame(() => {
          viewport.scrollLeft = (marker ? Number(marker.getAttribute('cx')) : svg.viewBox.baseVal.width / 2) - viewport.clientWidth / 2;
          viewport.scrollTop = (marker ? Number(marker.getAttribute('cy')) : svg.viewBox.baseVal.height / 2) - viewport.clientHeight / 2;
        });
      }
      if (!dialog.open) dialog.showModal();
    };
    dialog.addEventListener('click', (event) => {
      const action = event.target.closest('button[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'close') dialog.close();
      else if (action === 'save') {
        const svg = viewport.querySelector('svg').cloneNode(true);
        svg.removeAttribute('style');
        svg.classList.remove('fit');
        svg.setAttribute('width', svg.viewBox.baseVal.width);
        svg.setAttribute('height', svg.viewBox.baseVal.height);
        const bytes = new XMLSerializer().serializeToString(svg);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = dialog.dataset.filename + '-' + direction + '.svg';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
      else if (action === 'fit' || action === 'actual') {
        actual = action === 'actual'; show(direction);
      } else show(action);
    });
    document.querySelectorAll('button.inspect').forEach((button) =>
      button.addEventListener('click', () => show(button.dataset.direction)));
    show('N');
  })();
  </script></body></html>`;
}
