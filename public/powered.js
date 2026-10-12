/* The foot of every demo page: links to the privacy policy and terms (they live on the Domi website, so there's one
   version of each), and on a practice's own branded demo, "Powered by Domi" with Domi linking to that website.
   The address comes from the server (brand.site). */
(function () {
  "use strict";
  window.DomiPowered = function (brand) {
    if (!brand || !brand.site) return;
    let f = document.getElementById("powered");
    if (!f) { f = document.createElement("footer"); f.id = "powered"; f.className = "powered"; document.body.appendChild(f); }
    f.innerHTML = "";
    const link = (href, text) => { const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = text; return a; };
    if (brand.logo && !brand.legalOnly) {
      const p = document.createElement("p");
      p.append("Powered by ", link(brand.site, "Domi"));
      f.append(p);
    }
    const legal = document.createElement("p");
    legal.className = "legal";
    legal.append(link(brand.site + "privacy/", "Privacy policy"), " · ", link(brand.site + "terms/", "Terms and conditions"));
    f.append(legal);
  };
  /**
   * Breadcrumbs above a patient-facing page: the practice (linking to its own website when it has one) › this page.
   * `width` matches the page's column.
   */
  /**
   * Show form mistakes next to their fields: [[element, message], ...]. Clears earlier ones, marks each field
   * invalid for screen readers, and focuses the first. Returns true when there's nothing wrong.
   */
  window.DomiFieldErrors = function (root, errors) {
    root.querySelectorAll(".ferr").forEach((e) => e.remove());
    root.querySelectorAll("[aria-invalid=true]").forEach((e) => { e.removeAttribute("aria-invalid"); e.removeAttribute("aria-describedby"); });
    errors.forEach(([el, msg], i) => {
      if (!el) return;
      const id = "ferr-" + i, p = document.createElement("p");
      p.className = "ferr"; p.id = id; p.textContent = msg;
      el.setAttribute("aria-invalid", "true"); el.setAttribute("aria-describedby", id);
      const after = el.closest("label.opt, label.bk-choice, .pc-pick") || el;
      after.insertAdjacentElement("afterend", p);
    });
    const first = errors.find(([el]) => el);
    if (first) { first[0].focus({ preventScroll: true }); first[0].scrollIntoView({ block: "center", behavior: "smooth" }); }
    return !errors.length;
  };
  window.DomiCrumbs = function (brand, practice, here, width) {
    const main = document.querySelector("main"); if (!main || document.getElementById("crumbs")) return;
    const nav = document.createElement("nav");
    nav.id = "crumbs"; nav.className = "crumbs"; nav.setAttribute("aria-label", "Breadcrumb"); nav.style.maxWidth = (width || 680) + "px";
    const ol = document.createElement("ol");
    const home = document.createElement("li");
    if (brand && brand.website) { const a = document.createElement("a"); a.href = brand.website; a.rel = "noopener"; a.textContent = practice; home.append(a); }
    else home.textContent = practice;
    const cur = document.createElement("li"); const span = document.createElement("span"); span.setAttribute("aria-current", "page"); span.textContent = here; cur.append(span);
    ol.append(home, cur); nav.append(ol);
    main.parentNode.insertBefore(nav, main);
  };
})();
