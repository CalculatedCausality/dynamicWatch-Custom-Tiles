import { CFG, DW_LAYER_GROUPS } from "../config.js";
import { _escHtml } from "../utils/html.js";

/* -- Layer Manager UI -------------------------------------------------- */

export class LayerManagerUI {
	constructor(ctrl) {
		this._ctrl = ctrl;
	}

	// -- Archive persistence ------------------------------------------

	getArchived() {
		try {
			return new Set(
				JSON.parse(localStorage.getItem(CFG.ARCHIVE_KEY) || "[]"),
			);
		} catch (e) {
			return new Set();
		}
	}

	saveArchived(set) {
		localStorage.setItem(CFG.ARCHIVE_KEY, JSON.stringify([...set]));
	}

	toggleArchived(name, archive) {
		const set = this.getArchived();
		archive ? set.add(name) : set.delete(name);
		this.saveArchived(set);
	}

	// -- Leaflet control helpers --------------------------------------

	_getBaseLayers() {
		return this._ctrl._layers.filter((l) => !l.overlay);
	}

	_getActiveLayerName() {
		const m = this._ctrl._map;
		if (!m) return null;
		for (const item of this._getBaseLayers()) {
			if (m.hasLayer(item.layer)) return item.name;
		}
		return null;
	}

	_getLabelForName(name) {
		const container = this._ctrl.getContainer();
		if (!container) return null;
		const base = container.querySelector(".leaflet-control-layers-base");
		if (!base) return null;
		for (const label of base.querySelectorAll("label")) {
			if (!label.querySelector("input[type=radio]")) continue;
			if (label.dataset.dwName === name) return label;
			const span = label.querySelector("span");
			if (span && span.textContent.trim() === name) return label;
		}
		return null;
	}

	applyArchived() {
		const archived = this.getArchived();
		for (const item of this._getBaseLayers()) {
			const label = this._getLabelForName(item.name);
			if (label) label.style.display = archived.has(item.name) ? "none" : "";
		}
		const container = this._ctrl.getContainer();
		if (!container) return;
		const base = container.querySelector(".leaflet-control-layers-base");
		if (!base) return;
		for (const grp of base.querySelectorAll(".dw-layer-group")) {
			const all = [...grp.querySelectorAll("label")];
			grp.style.display =
				all.length && all.every((l) => l.style.display === "none")
					? "none"
					: "";
		}
	}

	// -- Manage-layers button and panel -------------------------------

	addManageButton() {
		const container = this._ctrl.getContainer();
		if (!container) return;
		const base = container.querySelector(".leaflet-control-layers-base");
		if (!base || base.querySelector(".dw-manage-btn")) return;

		const wrap = document.createElement("div");
		wrap.className = "dw-manage-btn";
		wrap.innerHTML =
			'<a href="#" class="dw-manage-link">&#9881;&#160;Manage layers</a>';
		base.appendChild(wrap);
		wrap.querySelector("a").addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.openPanel();
		});
	}

	openPanel() {
		const container = this._ctrl.getContainer();
		const base = container.querySelector(".leaflet-control-layers-base");
		const titleBar = container.querySelector(".title-bar");
		if (!base) return;

		const archived = this.getArchived();
		const activeName = this._getActiveLayerName();
		const items = this._getBaseLayers();

		for (const child of base.children) {
			child.dataset.dwDisplay = child.style.display;
			child.style.display = "none";
		}

		const origTitle = titleBar ? titleBar.textContent : null;
		if (titleBar) titleBar.textContent = "Manage Layers";

		const buildRow = (item, displayName) => {
			const isActive = item.name === activeName;
			const checked = !archived.has(item.name);
			const chkId = "dw-chk-" + item.name.replace(/[^a-z0-9]/gi, "_");
			return (
				`<label class="dw-manager-row${isActive ? " dw-manager-row--active" : ""}">` +
				`<input type="checkbox" id="${_escHtml(chkId)}"` +
				` data-name="${_escHtml(item.name)}"` +
				(checked ? " checked" : "") +
				(isActive
					? ' disabled title="Switch to another layer before archiving this one"'
					: "") +
				`><span class="dw-manager-name">${_escHtml(displayName || item.name)}</span>` +
				(isActive ? '<span class="dw-badge">active</span>' : "") +
				"</label>"
			);
		};
		const usedNames = new Set();
		let rows = "";
		for (const group of DW_LAYER_GROUPS) {
			const groupItems = items.filter((it) => group.names.includes(it.name));
			if (!groupItems.length) continue;
			rows += `<div class="dw-manager-group-hd">${_escHtml(group.header)}</div>`;
			rows += `<div class="dw-manager-group">`;
			for (const item of groupItems) {
				usedNames.add(item.name);
				const short = group.shortLabels && group.shortLabels[item.name];
				rows += buildRow(item, short);
			}
			rows += `</div>`;
		}
		for (const item of items) {
			if (!usedNames.has(item.name)) rows += buildRow(item, null);
		}

		const panel = document.createElement("div");
		panel.className = "dw-manager-panel";
		panel.innerHTML =
			'<p class="dw-manager-hint">Uncheck a layer to hide it from the map&#8209;type selector.</p>' +
			`<div class="dw-manager-list">${rows}</div>` +
			'<div class="dw-manager-footer"><a href="#" class="dw-back-link">&#8592;&#160;Back</a></div>';
		base.appendChild(panel);

		panel
			.querySelector(".dw-manager-list")
			.addEventListener("change", (e) => {
				if (e.target.type !== "checkbox") return;
				const name = e.target.getAttribute("data-name");
				if (name) this.toggleArchived(name, !e.target.checked);
			});

		panel.querySelector(".dw-back-link").addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.closePanel(panel, origTitle);
		});
	}

	closePanel(panel, origTitle) {
		const container = this._ctrl.getContainer();
		const base = container.querySelector(".leaflet-control-layers-base");
		const titleBar = container.querySelector(".title-bar");

		if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
		if (titleBar && origTitle !== null) titleBar.textContent = origTitle;

		for (const child of base.children) {
			if ("dwDisplay" in child.dataset) {
				child.style.display = child.dataset.dwDisplay;
				delete child.dataset.dwDisplay;
			}
		}
		this.applyArchived();
	}

	setup() {
		setTimeout(() => {
			this.applyArchived();
			this.addManageButton();
		}, 0);
	}
}

