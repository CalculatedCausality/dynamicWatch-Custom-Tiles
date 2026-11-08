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
		row.insertBefore(btn, row.querySelector(".distance"));
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
