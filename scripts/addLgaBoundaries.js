// Backfills each already-fetched city file with its actual LGA boundary
// polygon (lgaBoundary), so locale resolution can check true administrative
// containment instead of using a suburb polygon as an imprecise proxy -
// suburbs often straddle two LGAs, so "point is inside a copy of this
// suburb" can be true in more than one city's file at once.
//
// Run: node addLgaBoundaries.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const localesIndex = require(path.join(ROOT, '..', 'locale', 'data', 'locales-index.json'));

const DELAY_MS = 250;

// Locale id -> exact ABS lga_name_2021 to search for, where it differs from
// the locale's display name.
const NAME_OVERRIDES = {
  canberra: 'Unincorporated ACT',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

async function fetchLgaGeometry(name) {
  const trimmed = name.trim();
  const escaped = trimmed.replace(/'/g, "''"); // SQL string literal escaping for the ArcGIS `where` param
  const exactUrl =
    'https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/LGA/FeatureServer/0/query?' +
    `where=${encodeURIComponent(`lga_name_2021='${escaped}'`)}&outFields=lga_code_2021&returnGeometry=true&outSR=4326&f=json`;
  let data = await fetchJson(exactUrl);
  if (data.features && data.features.length > 0) return data.features[0].geometry;

  const likeUrl =
    'https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/LGA/FeatureServer/0/query?' +
    `where=${encodeURIComponent(`lga_name_2021 LIKE '${escaped}%'`)}&outFields=lga_code_2021&returnGeometry=true&outSR=4326&f=json`;
  data = await fetchJson(likeUrl);
  if (data.features && data.features.length > 0) return data.features[0].geometry;

  return null;
}

// Esri "rings" -> our simplified GeoJSON-like shape. We don't distinguish
// holes from disjoint outer rings (the app's point-in-polygon already
// doesn't handle holes for suburb data either) - each ring is treated as
// its own polygon and a point counts as inside if it's inside ANY ring.
function ringsToGeometry(esriGeometry) {
  const rings = esriGeometry.rings;
  if (rings.length === 1) {
    return { type: 'Polygon', coordinates: [rings[0]] };
  }
  return { type: 'MultiPolygon', coordinates: rings.map((ring) => [ring]) };
}

function loadReport() {
  const reportPath = path.join(__dirname, 'boundary-report.json');
  if (fs.existsSync(reportPath)) {
    return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  }
  return { done: [], failed: [] };
}

function saveReport(report) {
  fs.writeFileSync(path.join(__dirname, 'boundary-report.json'), JSON.stringify(report, null, 2));
}

async function main() {
  const locales = localesIndex.locales;
  console.log(`Backfilling LGA boundaries for ${locales.length} locales.`);

  const report = loadReport();
  const done = new Set(report.done);

  for (let i = 0; i < locales.length; i++) {
    const locale = locales[i];
    if (done.has(locale.id)) {
      console.log(`[${i + 1}/${locales.length}] ${locale.name} — already done, skipping`);
      continue;
    }

    const match = locale.url.match(/main\/(au\/.+\.json)$/);
    const filePath = path.join(ROOT, match[1]);
    if (!fs.existsSync(filePath)) {
      console.log(`[${i + 1}/${locales.length}] ${locale.name} — file not found, skipping`);
      report.failed.push({ id: locale.id, reason: 'file not found' });
      saveReport(report);
      continue;
    }

    const searchName = NAME_OVERRIDES[locale.id] || locale.name;
    process.stdout.write(`[${i + 1}/${locales.length}] ${locale.name}... `);

    try {
      const esriGeometry = await fetchLgaGeometry(searchName);
      if (!esriGeometry) {
        console.log('no LGA boundary found');
        report.failed.push({ id: locale.id, reason: 'no LGA boundary found' });
        saveReport(report);
        await sleep(DELAY_MS);
        continue;
      }

      const lgaBoundary = ringsToGeometry(esriGeometry);
      const cityData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      cityData.lgaBoundary = lgaBoundary;
      fs.writeFileSync(filePath, JSON.stringify(cityData));

      report.done.push(locale.id);
      saveReport(report);
      console.log(`ok (${lgaBoundary.type}, ${JSON.stringify(lgaBoundary.coordinates).length} chars)`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      report.failed.push({ id: locale.id, reason: err.message });
      saveReport(report);
    }

    await sleep(DELAY_MS);
  }

  console.log(`\nDone. ${report.done.length} backfilled, ${report.failed.length} failed.`);
}

main();
