// Shared L.Layer scaffold for view-driven data overlays that refresh on a timer.
export function pollingDataLayer(opts) {
	return L.Layer.extend({
		initialize() {
			this._group = null;
			this._timer = null;
			this._debounce = null;
		},
		onAdd(map) {
			if (!map.getPane(opts.pane)) {
				map.createPane(opts.pane);
				map.getPane(opts.pane).style.zIndex = String(opts.paneZIndex);
			}
			this._group = L.layerGroup().addTo(map);
			this._startPoll();
			map.on("moveend zoomend", this._onViewChange, this);
		},
		onRemove(map) {
			clearInterval(this._timer);
			clearTimeout(this._debounce);
			this._timer = this._debounce = null;
			map.off("moveend zoomend", this._onViewChange, this);
			if (this._group) { this._group.remove(); this._group = null; }
		},
		_startPoll() {
			clearInterval(this._timer);
			this._fetchGuarded();
			if (opts.pollMs) {
				this._timer = setInterval(() => this._fetchGuarded(), opts.pollMs);
			}
		},
		_onViewChange() {
			clearInterval(this._timer);
			clearTimeout(this._debounce);
			this._timer = null;
			this._debounce = setTimeout(() => this._startPoll(), opts.debounceMs || 400);
		},
		_fetchGuarded() {
			const map = this._map;
			if (!map || !this._group) return;
			if (map.getZoom() < opts.minZoom) {
				this._group.clearLayers();
				return;
			}
			opts.fetch(map, this._group, this);
		},
		getAttribution() { return opts.attribution; },
	});
}
