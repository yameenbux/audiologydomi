"use strict";
// The areas a practice covers: towns, each with its postcode districts, and an approximate centre for each
// district. Drop-downs offer these, the import flags postcodes outside them, and drive times between places
// without a known full postcode are estimated from these centres.
//
// "leeds" is the default demo practice. "nw" is the North West round that Home Visiting Optics covers
// (Blackburn, Blackpool, Bolton, Bury, Manchester, Oldham, Warrington and Wigan, from their website).
// The centres are approximate, to a few hundred metres: good for estimates, not for directions.

const REGIONS = {
  leeds: {
    name: "Leeds",
    towns: [
      { town: "North Leeds", districts: { LS6: [53.825, -1.578], LS7: [53.823, -1.535], LS16: [53.860, -1.605], LS17: [53.858, -1.540], LS18: [53.840, -1.640] } },
      { town: "East Leeds", districts: { LS8: [53.824, -1.505], LS9: [53.801, -1.513], LS14: [53.825, -1.455], LS15: [53.805, -1.450], LS26: [53.748, -1.475] } },
      { town: "South & West Leeds", districts: { LS10: [53.770, -1.535], LS11: [53.776, -1.565], LS12: [53.795, -1.600], LS13: [53.808, -1.640], LS27: [53.745, -1.600], LS28: [53.795, -1.665] } },
    ],
  },
  nw: {
    name: "the North West",
    towns: [
      { town: "Blackburn", districts: { BB1: [53.760, -2.462], BB2: [53.740, -2.505], BB3: [53.698, -2.468] } },
      { town: "Blackpool", districts: { FY1: [53.815, -3.050], FY2: [53.848, -3.040], FY3: [53.825, -3.015], FY4: [53.785, -3.022] } },
      { town: "Bolton", districts: { BL1: [53.590, -2.452], BL2: [53.585, -2.392], BL3: [53.565, -2.440], BL4: [53.550, -2.392], BL5: [53.548, -2.530], BL6: [53.600, -2.550], BL7: [53.620, -2.412] } },
      { town: "Bury", districts: { BL8: [53.605, -2.335], BL9: [53.595, -2.290] } },
      { town: "Manchester", districts: { M8: [53.508, -2.238], M9: [53.522, -2.200], M11: [53.480, -2.180], M12: [53.465, -2.200], M13: [53.462, -2.225], M14: [53.445, -2.222], M16: [53.455, -2.265], M18: [53.460, -2.170], M19: [53.435, -2.190], M20: [53.415, -2.230], M21: [53.440, -2.275], M22: [53.380, -2.260], M23: [53.395, -2.290], M40: [53.510, -2.190] } },
      { town: "Oldham", districts: { OL1: [53.546, -2.110], OL2: [53.570, -2.100], OL4: [53.540, -2.070], OL8: [53.525, -2.120], OL9: [53.545, -2.145] } },
      { town: "Warrington", districts: { WA1: [53.390, -2.580], WA2: [53.410, -2.585], WA3: [53.430, -2.520], WA4: [53.370, -2.570], WA5: [53.400, -2.630] } },
      { town: "Wigan", districts: { WN1: [53.552, -2.630], WN2: [53.535, -2.590], WN3: [53.535, -2.655], WN4: [53.490, -2.640], WN5: [53.535, -2.700], WN6: [53.575, -2.670], WN7: [53.497, -2.520] } },
    ],
  },
};

/** Every district centre across every region, for the drive-time estimates. */
const ALL_CENTRES = Object.fromEntries(Object.values(REGIONS).flatMap((r) => r.towns.flatMap((t) => Object.entries(t.districts))));

/** What the browser needs for the drop-downs: towns in order, each with its districts. */
const areasFor = (id) => (REGIONS[id] || REGIONS.leeds).towns.map((t) => ({ town: t.town, districts: Object.keys(t.districts) }));
/** Which town a postcode district belongs to in this region, or null if it's outside the area. */
function townOf(id, district) {
  const t = (REGIONS[id] || REGIONS.leeds).towns.find((x) => district in x.districts);
  return t ? t.town : null;
}

module.exports = { REGIONS, ALL_CENTRES, areasFor, townOf };
