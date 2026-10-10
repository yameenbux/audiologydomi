"use strict";
// Drive-time estimates between postcode districts. Straight-line distance between approximate district
// centres, scaled for roads and city speeds. Good enough to rank slots; production would call a routing
// service (e.g. OpenRouteService or Google Distance Matrix) with full postcodes.
const { district } = require("./domain");

const CENTRES = {
  LS6: [53.825, -1.578], LS7: [53.823, -1.535], LS8: [53.824, -1.505], LS9: [53.801, -1.513],
  LS10: [53.770, -1.535], LS11: [53.776, -1.565], LS12: [53.795, -1.600], LS13: [53.808, -1.640],
  LS14: [53.825, -1.455], LS15: [53.805, -1.450], LS16: [53.860, -1.605], LS17: [53.858, -1.540],
  LS18: [53.840, -1.640], LS26: [53.748, -1.475], LS27: [53.745, -1.600], LS28: [53.795, -1.665],
};
const SAME_DISTRICT_MIN = 6;
const ROAD_FACTOR = 1.3;   // roads are longer than straight lines
const MIN_PER_KM = 2;      // about 30 km/h across the city
const PARK_MIN = 4;        // finding somewhere to park, walking to the door

function km([lat1, lon1], [lat2, lon2]) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** Estimated minutes to drive between two postcodes (or districts). Null if either is unknown. */
function driveMinutes(from, to) {
  const a = CENTRES[district(from)], b = CENTRES[district(to)];
  if (!a || !b) return null;
  if (a === b) return SAME_DISTRICT_MIN;
  return Math.round(PARK_MIN + km(a, b) * ROAD_FACTOR * MIN_PER_KM);
}

const known = (pc) => !!CENTRES[district(pc)];

module.exports = { driveMinutes, known, CENTRES };
