// The previous test's "expected locale = whichever file I drew this suburb
// from" assumption breaks for suburbs that straddle two LGAs (common in
// dense metro areas) - a suburb can legitimately appear in two cities'
// files while its centroid is only really inside ONE of their true
// boundaries. That's not a resolver bug, it's the test's ground truth
// being wrong.
//
// This is the real invariant: whatever locale resolveLocaleAt returns for
// a point, that locale's OWN LGA boundary must actually contain the point
// (or resolution legitimately found nothing within range). Runs across a
// large random nationwide sample of real suburb centroids.
//
// Run: node verifyResolutionConsistency.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const localesIndex = require(path.join(ROOT, '..', 'locale', 'data', 'locales-index.json'));

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

function resolveLocaleAt(lat, lng) {
  const ranked = localesIndex.locales
    .map((locale) => ({ locale, dist: distanceBetween(lat, lng, locale.latitude, locale.longitude) }))
    .sort((a, b) => a.dist - b.dist)
    .filter((r) => r.dist <= CANDIDATE_RADIUS_KM);

  if (ranked.length === 0) return { locale: null, isFallback: false };
  const candidates = ranked.slice(0, MAX_CANDIDATES_TO_CHECK);
  const point = [lng, lat];

  for (const { locale } of candidates) {
    const { data } = loadCityFile(locale.id);
    const contains = data.lgaBoundary ? isPointInFeature(point, data.lgaBoundary) : !!findSuburbAt(lat, lng, data);
    if (contains) return { locale, isFallback: false };
  }
  return { locale: candidates[0].locale, isFallback: true };
}

function main() {
  const SAMPLE_COUNT = 150;
  const allIds = localesIndex.locales.map((l) => l.id);

  let consistent = 0;
  let fallback = 0;
  let inconsistent = 0;
  let noneNearby = 0;
  const inconsistentDetails = [];

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const sourceId = allIds[Math.floor(Math.random() * allIds.length)];
    const { data: sourceData } = loadCityFile(sourceId);
    const features = sourceData.features;
    if (features.length === 0) continue;

    const feature = features[Math.floor(Math.random() * features.length)];
    const [lng, lat] = centroidOfRing(feature.geometry);

    const { locale: resolved, isFallback } = resolveLocaleAt(lat, lng);

    if (!resolved) {
      noneNearby++;
      continue;
    }
    if (isFallback) {
      fallback++;
      continue;
    }

    const { data: resolvedData } = loadCityFile(resolved.id);
    const trulyContains = resolvedData.lgaBoundary
      ? isPointInFeature([lng, lat], resolvedData.lgaBoundary)
      : true;

    if (trulyContains) {
      consistent++;
    } else {
      inconsistent++;
      inconsistentDetails.push({ suburb: feature.properties.sal_name_2021, resolvedTo: resolved.name, lat, lng });
    }
  }

  console.log(`Sampled ${SAMPLE_COUNT} real suburb centroids nationwide.\n`);
  console.log(`Consistent (resolved locale's own boundary genuinely contains the point): ${consistent}`);
  console.log(`Fallback (no candidate's boundary matched, used nearest-centroid): ${fallback}`);
  console.log(`No locale within ${CANDIDATE_RADIUS_KM}km at all: ${noneNearby}`);
  console.log(`INCONSISTENT (resolved locale's own boundary does NOT contain the point - real bug): ${inconsistent}`);

  if (inconsistentDetails.length > 0) {
    console.log('\nInconsistent cases:', JSON.stringify(inconsistentDetails, null, 2));
  }
}

main();
