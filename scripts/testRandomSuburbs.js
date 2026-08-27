// Data-correctness test: picks ~20 random suburbs spread across the country
// (plus a few deliberate disambiguation cases, e.g. "Campbelltown (NSW)" vs
// "Campbelltown (SA)") and, for each, verifies:
//   1. A point inside the suburb's own polygon is detected as that suburb
//      when checked against every suburb in its city file (self-consistency).
//   2. findNearestLocale (run against the full 542-locale index) resolves
//      that point back to the SAME city/locale it came from — the critical
//      check for disambiguated LGAs that share a base name across states.
//
// This mirrors the app's own isPointInPolygon/isPointInFeature and
// findNearestLocale logic exactly, but runs against the raw data instead of
// through Expo Go, since the app only ever loads one locale per session.
//
// Run: node testRandomSuburbs.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const localesIndex = require(path.join(ROOT, '..', 'locale', 'data', 'locales-index.json'));

// A handful of known disambiguation pairs (same base LGA name, different states).
const DISAMBIGUATION_IDS = [
  'baysidensw', 'baysidevic',
  'campbelltownnsw', 'campbelltownsa',
  'centralcoastnsw', 'centralcoasttas',
  'kingstonvic', 'kingstonsa',
  'centralhighlandsqld', 'centralhighlandstas',
  'flindersqld', 'flinderstas',
  'latrobevic', 'latrobetas',
];

function isPointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function isPointInFeature(point, geometry) {
  if (geometry.type === 'Polygon') return isPointInPolygon(point, geometry.coordinates[0]);
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => isPointInPolygon(point, polygon[0]));
  }
  return false;
}

function centroidOfRing(geometry) {
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
      n++;
    }
  }
  return [sx / n, sy / n];
}

function distanceBetween(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function findNearestLocale(lat, lng) {
  let nearest = localesIndex.locales[0];
  let nearestDist = distanceBetween(lat, lng, nearest.latitude, nearest.longitude);
  for (const locale of localesIndex.locales.slice(1)) {
    const dist = distanceBetween(lat, lng, locale.latitude, locale.longitude);
    if (dist < nearestDist) {
      nearest = locale;
      nearestDist = dist;
    }
  }
  return { locale: nearest, dist: nearestDist };
}

function loadCityFile(localeId) {
  const locale = localesIndex.locales.find((l) => l.id === localeId);
  if (!locale) throw new Error(`No locale in index for id "${localeId}"`);
  const match = locale.url.match(/main\/(au\/.+\.json)$/);
  const filePath = path.join(ROOT, match[1]);
  return { locale, data: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
}

// Try random suburbs in a city file until one gives a point that lands
// inside its own polygon (some concave/coastal shapes fail on a plain
// ring-average centroid) — retry a few times before giving up on this city.
function pickTestPointInCity(cityData, maxAttempts = 8) {
  const features = cityData.features;
  for (let i = 0; i < maxAttempts && features.length > 0; i++) {
    const feature = features[Math.floor(Math.random() * features.length)];
    const [lng, lat] = centroidOfRing(feature.geometry);
    if (isPointInFeature([lng, lat], feature.geometry)) {
      return { suburbName: feature.properties.sal_name_2021, lat, lng };
    }
  }
  return null;
}

function runTest(localeId) {
  const { locale, data } = loadCityFile(localeId);
  const point = pickTestPointInCity(data);
  if (!point) {
    return { localeId, name: locale.name, result: 'SKIP', reason: 'no suburb centroid landed inside its own polygon after retries' };
  }

  // Self-consistency: does scanning the whole city file re-detect the same suburb?
  let selfDetected = null;
  for (const f of data.features) {
    if (isPointInFeature([point.lng, point.lat], f.geometry)) {
      selfDetected = f.properties.sal_name_2021;
      break;
    }
  }

  // Nationwide: does findNearestLocale resolve this point back to this same city?
  const { locale: nearestLocale, dist } = findNearestLocale(point.lat, point.lng);

  const pointInPolygonOk = selfDetected === point.suburbName;
  const nearestLocaleOk = nearestLocale.id === localeId;

  return {
    localeId,
    name: locale.name,
    suburb: point.suburbName,
    lat: point.lat,
    lng: point.lng,
    pointInPolygonOk,
    nearestLocaleOk,
    nearestLocaleFound: nearestLocale.id,
    nearestDistKm: dist,
    result: pointInPolygonOk && nearestLocaleOk ? 'PASS' : 'FAIL',
  };
}

function main() {
  const allIds = localesIndex.locales.map((l) => l.id);
  const randomCount = 14;

  const chosen = new Set(DISAMBIGUATION_IDS);
  while (chosen.size < DISAMBIGUATION_IDS.length + randomCount) {
    chosen.add(allIds[Math.floor(Math.random() * allIds.length)]);
  }

  const results = [];
  for (const id of chosen) {
    results.push(runTest(id));
  }

  console.log(`Testing ${results.length} locales (${DISAMBIGUATION_IDS.length} deliberate disambiguation cases + ${results.length - DISAMBIGUATION_IDS.length} random):\n`);

  for (const r of results) {
    if (r.result === 'SKIP') {
      console.log(`SKIP  ${r.name.padEnd(30)} ${r.reason}`);
      continue;
    }
    const status = r.result === 'PASS' ? 'PASS' : 'FAIL';
    const pip = r.pointInPolygonOk ? 'ok' : 'MISMATCH';
    const nl = r.nearestLocaleOk ? 'ok' : `WRONG (got "${r.nearestLocaleFound}")`;
    console.log(
      `${status}  ${r.name.padEnd(30)} suburb="${r.suburb}"  point-in-polygon:${pip}  nearest-locale:${nl}  (${r.nearestDistKm.toFixed(2)}km)`
    );
  }

  const passed = results.filter((r) => r.result === 'PASS').length;
  const failed = results.filter((r) => r.result === 'FAIL').length;
  const skipped = results.filter((r) => r.result === 'SKIP').length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped, out of ${results.length}.`);
}

main();
