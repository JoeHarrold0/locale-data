// Verifies the resolveLocaleAt fix (candidate-radius + polygon-containment,
// mirrored from utils/localeManager.ts) actually resolves suburbs to their
// correct locale, instead of the old nearest-centroid-only approach.
//
// Run: node testLocaleResolution.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const localesIndex = require(path.join(ROOT, '..', 'locale', 'data', 'locales-index.json'));

const DISAMBIGUATION_IDS = [
  'baysidensw', 'baysidevic',
  'campbelltownnsw', 'campbelltownsa',
  'centralcoastnsw', 'centralcoasttas',
  'kingstonvic', 'kingstonsa',
  'centralhighlandsqld', 'centralhighlandstas',
  'flindersqld', 'flinderstas',
  'latrobevic', 'latrobetas',
];

const CANDIDATE_RADIUS_KM = 300;
const MAX_CANDIDATES_TO_CHECK = 15;

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
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((p) => isPointInPolygon(point, p[0]));
  return false;
}
function findSuburbAt(lat, lng, data) {
  const point = [lng, lat];
  for (const f of data.features) {
    if (isPointInFeature(point, f.geometry)) return f.properties.sal_name_2021;
  }
  return null;
}
function centroidOfRing(geometry) {
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
  let sx = 0, sy = 0, n = 0;
  for (const ring of rings) for (const [x, y] of ring) { sx += x; sy += y; n++; }
  return [sx / n, sy / n];
}
function distanceBetween(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

const fileCache = new Map();
function loadCityFile(localeId) {
  if (fileCache.has(localeId)) return fileCache.get(localeId);
  const locale = localesIndex.locales.find((l) => l.id === localeId);
  const match = locale.url.match(/main\/(au\/.+\.json)$/);
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, match[1]), 'utf8'));
  const result = { locale, data };
  fileCache.set(localeId, result);
  return result;
}

// Mirrors utils/localeManager.ts resolveLocaleAt exactly.
function resolveLocaleAt(lat, lng) {
  const ranked = localesIndex.locales
    .map((locale) => ({ locale, dist: distanceBetween(lat, lng, locale.latitude, locale.longitude) }))
    .sort((a, b) => a.dist - b.dist)
    .filter((r) => r.dist <= CANDIDATE_RADIUS_KM);

  if (ranked.length === 0) return null;
  const candidates = ranked.slice(0, MAX_CANDIDATES_TO_CHECK);
  const point = [lng, lat];

  for (const { locale } of candidates) {
    const { data } = loadCityFile(locale.id);
    const contains = data.lgaBoundary ? isPointInFeature(point, data.lgaBoundary) : !!findSuburbAt(lat, lng, data);
    if (contains) {
      return locale;
    }
  }
  return candidates[0].locale; // fallback
}

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

function main() {
  const allIds = localesIndex.locales.map((l) => l.id);
  const randomCount = 26;

  const chosen = new Set(DISAMBIGUATION_IDS);
  while (chosen.size < DISAMBIGUATION_IDS.length + randomCount) {
    chosen.add(allIds[Math.floor(Math.random() * allIds.length)]);
  }

  let pass = 0, fail = 0, skip = 0;
  const failures = [];

  for (const localeId of chosen) {
    const { locale, data } = loadCityFile(localeId);
    const point = pickTestPointInCity(data);
    if (!point) { skip++; continue; }

    const resolved = resolveLocaleAt(point.lat, point.lng);
    const ok = resolved && resolved.id === localeId;
    if (ok) {
      pass++;
      console.log(`PASS  ${locale.name.padEnd(30)} suburb="${point.suburbName}" -> resolved to ${resolved.name}`);
    } else {
      fail++;
      failures.push({ locale: locale.name, suburb: point.suburbName, gotInstead: resolved ? resolved.name : 'null' });
      console.log(`FAIL  ${locale.name.padEnd(30)} suburb="${point.suburbName}" -> resolved to ${resolved ? resolved.name : 'null'} (expected ${locale.name})`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped, out of ${pass + fail + skip}.`);
  if (failures.length > 0) {
    console.log('\nFailures:', JSON.stringify(failures, null, 2));
  }
}

main();
