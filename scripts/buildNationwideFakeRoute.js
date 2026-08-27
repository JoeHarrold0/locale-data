// Picks ~20 real suburb centroids across the country (including several
// deliberately tricky cases) for a live in-app FAKE_ROUTE test, and
// precomputes what resolveLocaleAt SHOULD return for each one using the
// exact production algorithm - so we have ground truth to compare against
// what the app actually announces on-device.
//
// Run: node buildNationwideFakeRoute.js

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
  if (!locale) throw new Error(`No locale "${localeId}"`);
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

// [sourceLocaleId, description, preferredSuburbName-or-null]
const TARGETS = [
  ['sydney', 'capital city', null],
  ['melbourne', 'capital city', null],
  ['perth', 'capital city', null],
  ['adelaide', 'capital city', null],
  ['hobart', 'capital city', null],
  ['darwin', 'capital city', null],
  ['canberra', 'capital city (whole-territory locale, no real LGA)', 'Braddon'],
  ['brisbane', 'capital city', null],
  ['campbelltownnsw', 'disambiguation pair 1/2', null],
  ['campbelltownsa', 'disambiguation pair 2/2 (same base name, other side of the country)', null],
  ['baysidensw', 'disambiguation pair 1/2', null],
  ['baysidevic', 'disambiguation pair 2/2', 'Ormond'], // known to straddle into Glen Eira - the exact case the LGA-boundary fix addresses
  ['nedlands', 'tiny inner-Perth council', null],
  ['cottesloe', 'tiny inner-Perth council', null],
  ['breakoday', "LGA name has an apostrophe (regression check for the SQL-escaping fix)", null],
  ['kingisland', 'island LGA (MultiPolygon boundary)', null],
  ['kangarooisland', 'island LGA (MultiPolygon boundary)', null],
  ['torresstraitisland', 'remote island group, MultiPolygon', null],
  ['centraldesert', 'huge remote outback LGA - likely exercises the fallback path', null],
  ['goldcoast', 'capital-adjacent city', null],
];

function pickPoint(localeId, preferredName) {
  const { locale, data } = loadCityFile(localeId);
  let feature = preferredName
    ? data.features.find((f) => f.properties.sal_name_2021 === preferredName)
    : null;

  const features = data.features;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (!feature) feature = features[Math.floor(Math.random() * features.length)];
    const [lng, lat] = centroidOfRing(feature.geometry);
    if (isPointInFeature([lng, lat], feature.geometry)) {
      return { sourceLocale: locale, suburbName: feature.properties.sal_name_2021, lat, lng };
    }
    feature = null; // retry with a different random suburb
  }
  throw new Error(`Couldn't find a valid point in ${localeId}`);
}

function main() {
  const route = [];
  for (const [localeId, desc, preferredName] of TARGETS) {
    const point = pickPoint(localeId, preferredName);
    const { locale: resolved, isFallback } = resolveLocaleAt(point.lat, point.lng);
    const expectedSuburb = resolved ? (loadCityFile(resolved.id).data && findSuburbAt(point.lat, point.lng, loadCityFile(resolved.id).data)) : null;

    route.push({
      desc,
      lat: point.lat,
      lng: point.lng,
      sourceSuburb: point.suburbName,
      sourceLocale: point.sourceLocale.name,
      expectedLocale: resolved ? resolved.name : 'NONE (out of range)',
      expectedSuburb: expectedSuburb || '(no suburb match - would just show "watching")',
      isFallback,
    });
  }

  console.log('--- Route summary (what to expect on-device) ---\n');
  route.forEach((r, i) => {
    const flag = r.isFallback ? '  [FALLBACK: nearest-centroid, no exact boundary match]' : '';
    console.log(`${i + 1}. ${r.desc}`);
    console.log(`   Picked suburb "${r.sourceSuburb}" from ${r.sourceLocale}'s data`);
    console.log(`   Expect locale: ${r.expectedLocale}${flag}`);
    console.log(`   Expect announcement: "Now entering ${r.expectedSuburb}"\n`);
  });

  const routeTs = route
    .map((r) => `  { latitude: ${r.lat}, longitude: ${r.lng} }, // ${r.desc} — expect ${r.expectedLocale} / "${r.expectedSuburb}"`)
    .join('\n');

  fs.writeFileSync(path.join(__dirname, 'nationwideFakeRoute.ts.txt'), routeTs);
  fs.writeFileSync(path.join(__dirname, 'nationwideFakeRoute-expected.json'), JSON.stringify(route, null, 2));
  console.log('Wrote nationwideFakeRoute.ts.txt and nationwideFakeRoute-expected.json');
}

main();
