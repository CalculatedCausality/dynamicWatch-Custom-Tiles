/* -- Hover stack ------------------------------------------------------------
 * Several overlays can describe the spot under the pointer at once (an INTVL
 * runner, a suburb, a postcode, a mine…). Each used to open its own tooltip
 * at the same place, so they covered each other. Now each gets a slot that
 * behaves like a Leaflet tooltip (setLatLng / setContent / addTo / remove /
 * _map), and one shared tooltip per map shows every filled slot, in a fixed
 * order, separated by thin rules.
 */

const stacks = new WeakMap();

function stackFor(map) {
	let s = stacks.get(map);
	if (!s) {
		s = { slots: new Set(), latlng: null, tip: null };
		stacks.set(map, s);
	}
	return s;
}

// The combined content for the slots shown: lowest order first, each part
// wrapped with its own class so per-layer styles still apply.
export function hoverStackHtml(slots) {
	return [...slots].filter((s) => s._html)
		.sort((a, b) => a.order - b.order || a.id - b.id)
		.map((s) => `<div class="dw-hover-part${s.className ? " " + s.className : ""}">${s._html}</div>`)
		.join(`<div class="dw-hover-sep"></div>`);
}

function render(map) {
	const s = stackFor(map);
	const html = hoverStackHtml(s.slots);
	if (!html) { if (s.tip && s.tip._map) s.tip.remove(); return; }
	if (!s.tip) {
		s.tip = L.tooltip({ sticky: true, opacity: 0.95, className: "dw-qpws-tip dw-hover-stack", direction: "right", offset: [12, 0] });
	}
	s.tip.setLatLng(s.latlng).setContent(html);
	if (!s.tip._map) s.tip.addTo(map);
}

let nextId = 0;

// A tooltip-shaped slot. `order` sets its place in the box (lower first);
// `className` is kept on its part of the box.
export function hoverSlot(opts = {}) {
	const slot = {
		id: ++nextId,
		order: opts.order ?? 50,
		className: opts.className || "",
		_map: null,
		_html: "",
		_latlng: null,
		setLatLng(latlng) {
			this._latlng = latlng;
			if (this._map) { stackFor(this._map).latlng = latlng; render(this._map); }
			return this;
		},
		setContent(html) {
			this._html = html || "";
			if (this._map) render(this._map);
			return this;
		},
		getLatLng() { return this._latlng; },
		addTo(map) {
			this._map = map;
			const s = stackFor(map);
			s.slots.add(this);
			if (this._latlng) s.latlng = this._latlng;
			render(map);
			return this;
		},
		remove() {
			const map = this._map;
			if (!map) return this;
			this._map = null;
			stackFor(map).slots.delete(this);
			render(map);
			return this;
		},
	};
	return slot;
}
