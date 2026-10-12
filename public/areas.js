/* Town → postcode area → rest of the postcode, for every form that asks where a patient lives.
   The towns and their postcode districts are the practice's own (server/regions.js), so the office picks
   from the areas it actually covers rather than typing a postcode that might be mistyped or out of area.
   "Somewhere else" keeps a typed postcode possible for the odd patient outside the usual towns. */
(function () {
  "use strict";
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const OTHER = "__other";
  const split = (pc) => { const m = String(pc || "").toUpperCase().replace(/\s+/g, "").match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})?$/); return m ? { district: m[1], rest: m[2] || "" } : null; };

  /** The picker's HTML. `id` prefixes its fields; `pc` pre-fills it. */
  function picker(areas, id, pc, { big = false } = {}) {
    const p = split(pc), town = p && (areas.find((a) => a.districts.includes(p.district)) || {}).town;
    const t = town || (p ? OTHER : (areas.length === 1 ? areas[0].town : ""));
    const cls = big ? "input" : "input";
    const districts = (areas.find((a) => a.town === t) || { districts: [] }).districts;
    return `<div class="pc-pick${big ? " big" : ""}" data-pick="${esc(id)}">
      <div class="pc-row">
        <label class="pc-f"><span>Town</span><select class="${cls}" id="${esc(id)}-town" data-role="town" required>
          <option value="">Choose…</option>${areas.map((a) => `<option ${a.town === t ? "selected" : ""}>${esc(a.town)}</option>`).join("")}<option value="${OTHER}" ${t === OTHER ? "selected" : ""}>Somewhere else</option></select></label>
        <label class="pc-f" ${t === OTHER ? "hidden" : ""}><span>Postcode area</span><select class="${cls}" id="${esc(id)}-district" data-role="district" ${t && t !== OTHER ? "" : "disabled"}>
          ${districts.length ? districts.map((d) => `<option ${p && p.district === d ? "selected" : ""}>${esc(d)}</option>`).join("") : `<option value="">Pick a town first</option>`}</select></label>
        <label class="pc-f pc-rest" ${t === OTHER ? "hidden" : ""}><span>Rest of postcode</span><input class="${cls}" id="${esc(id)}-rest" data-role="rest" maxlength="4" placeholder="e.g. 4AB" autocapitalize="characters" autocomplete="off" value="${esc(p && town ? p.rest : "")}"></label>
      </div>
      <label class="pc-f pc-other" ${t === OTHER ? "" : "hidden"}><span>Postcode</span><input class="${cls}" id="${esc(id)}-other" data-role="other" autocapitalize="characters" autocomplete="postal-code" placeholder="Full postcode" value="${esc(t === OTHER ? pc : "")}"></label>
    </div>`;
  }

  /** The postcode the picker holds: "BL1 4AB", or just "BL1" when the rest is left blank. */
  function read(root, id) {
    const q = (r) => root.querySelector(`[data-pick="${id}"] [data-role="${r}"]`);
    if (!q("town")) return "";
    if (q("town").value === OTHER) return q("other").value.trim().toUpperCase();
    const d = q("district").value, rest = q("rest").value.replace(/\s+/g, "").toUpperCase();
    return d ? (rest ? `${d} ${rest}` : d) : "";
  }

  /** Keep the postcode areas in step with the chosen town. One listener covers every picker on the page. */
  function bind(getAreas) {
    document.addEventListener("change", (e) => {
      const box = e.target.closest && e.target.closest(".pc-pick");
      if (!box || e.target.dataset.role !== "town") return;
      const t = e.target.value, other = t === OTHER, areas = getAreas() || [];
      const sel = box.querySelector('[data-role="district"]');
      const ds = (areas.find((a) => a.town === t) || { districts: [] }).districts;
      sel.innerHTML = ds.length ? ds.map((d) => `<option>${esc(d)}</option>`).join("") : `<option value="">Pick a town first</option>`;
      sel.disabled = !ds.length;
      sel.closest(".pc-f").hidden = other; box.querySelector(".pc-rest").hidden = other; box.querySelector(".pc-other").hidden = !other;
      (other ? box.querySelector('[data-role="other"]') : sel).focus();
    });
  }

  window.DomiAreas = { picker, read, bind };
})();
