const isGap = (node) => !!node && node.nodeType === 3 && !/\S/.test(node.nodeValue || "");

// Put a button in the planner row, before the distance readout. The site's
// own buttons are inline-blocks separated by the line breaks in its markup,
// and that whitespace is the gap between them; a button inserted by script
// has none and would sit flush against its neighbours. Give it the same
// separator on each side that has an element next to it. A row whose markup
// has no such whitespace is left alone, so the button still matches.
// `dw-planner-btn` lets the stylesheet close those gaps on very narrow screens.
export function insertPlannerButton(row, btn) {
	btn.classList.add("dw-planner-btn");
	const spaced = Array.from(row.childNodes).some(isGap);
	row.insertBefore(btn, row.querySelector(".distance"));
	if (!spaced) return;
	const gap = () => row.ownerDocument.createTextNode("\n");
	if (btn.previousSibling && !isGap(btn.previousSibling)) row.insertBefore(gap(), btn);
	if (btn.nextSibling && !isGap(btn.nextSibling)) row.insertBefore(gap(), btn.nextSibling);
}

// Mount a button in dynamic.watch's `.leaflet-planner-controls` row, beside
// the native travel-mode/undo/save buttons. The row renders late, so wait for
// it with a MutationObserver and warn if the site's markup has changed.
export function mountPlannerButton({ id, className, title, iconClass, onClick, onMount }) {
	const tryMount = () => {
		const row = document.querySelector(".leaflet-planner-controls");
		if (!row) return false;
		if (row.querySelector("#" + id)) return true;
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "btn btn-default fixed-width " + className;
		btn.id = id;
		btn.title = title;
		btn.setAttribute("aria-label", title);
		btn.setAttribute("aria-pressed", "false");
		const icon = document.createElement("i");
		icon.className = "fa " + iconClass;
		btn.appendChild(icon);
		insertPlannerButton(row, btn);
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			onClick(btn, e);
		});
		if (onMount) onMount(btn);
		return true;
	};
	if (tryMount()) return;
	const obs = new MutationObserver(() => {
		if (!tryMount()) return;
		obs.disconnect();
		clearTimeout(timeoutId);
	});
	obs.observe(document.body, { childList: true, subtree: true });
	const timeoutId = setTimeout(() => {
		obs.disconnect();
		if (document.getElementById(id)) return;
		console.warn(`[CustomTiles] "${title}" button not injected after 15s — ` +
			"couldn't find `.leaflet-planner-controls`; dynamic.watch may have " +
			"changed its planner toolbar.");
	}, 15_000);
}
