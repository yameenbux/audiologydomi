/* "Powered by Domi" at the foot of every page of a practice's own branded demo, with Domi linking to the
   Domi website (the address comes from the server: brand.site). Domi's own demo doesn't need it. */
(function () {
  "use strict";
  window.DomiPowered = function (brand) {
    let f = document.getElementById("powered");
    if (!brand || !brand.logo || !brand.site) { if (f) f.remove(); return; }
    if (!f) { f = document.createElement("footer"); f.id = "powered"; f.className = "powered"; document.body.appendChild(f); }
    f.innerHTML = "";
    const a = document.createElement("a");
    a.href = brand.site; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Domi";
    f.append("Powered by ", a);
  };
})();
