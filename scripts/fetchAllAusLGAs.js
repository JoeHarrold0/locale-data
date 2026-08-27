// Batch version of fetchAusCity.js: fetches suburb (SAL) boundaries for every
// real Australian LGA from the ABS ArcGIS API and writes one compact JSON file
// per city, plus a generated-locales-index.json ready to merge into the app.
//
// Run: node fetchAllAusLGAs.js
// Safe to re-run: already-saved city files are skipped unless --force is passed.

const fs = require('fs');
const path = require('path');

const DELAY_MS = 300;
const FORCE = process.argv.includes('--force');

// Administrative/statistical bucket LGAs, not real places people drive through.
const EXCLUDE_RE = /unincorporated|no usual address|migratory|offshore|shipping|other territories/i;

// Already hand-fetched and tested — don't overwrite these.
const SKIP_SLUGS = new Set(['brisbane', 'goldcoast']);

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, opts, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, opts);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

async function fetchLgaList() {
  const url =
    'https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/LGA/FeatureServer/0/query?' +
    'where=1%3D1&outFields=lga_code_2021,lga_name_2021,state_name_2021&returnGeometry=false&f=json&resultRecordCount=2000';
  const data = await fetchJson(url);
  return data.features.map((f) => f.attributes).filter((a) => !EXCLUDE_RE.test(a.lga_name_2021));
}

async function fetchLgaGeometry(code) {
  const url =
    'https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/LGA/FeatureServer/0/query?' +
    `where=${encodeURIComponent(`lga_code_2021='${code}'`)}&outFields=lga_code_2021&returnGeometry=true&outSR=4326&f=json`;
  const data = await fetchJson(url);
  if (!data.features || data.features.length === 0) return null;
  return data.features[0].geometry;
}

function centroidOf(geometry) {
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  for (const ring of geometry.rings) {
    for (const [x, y] of ring) {
      sumX += x;
      sumY += y;
      n++;
    }
  }
  return { longitude: sumX / n, latitude: sumY / n };
}

async function fetchSuburbs(geometry) {
  geometry.spatialReference = { wkid: 4326 };
  const params = new URLSearchParams();
  params.append('where', '1=1');
  params.append('outFields', '*');
  params.append('geometry', JSON.stringify(geometry));
  params.append('geometryType', 'esriGeometryPolygon');
  params.append('spatialRel', 'esriSpatialRelIntersects');
  params.append('f', 'geojson');

  const url = 'https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/SAL/FeatureServer/0/query';
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}

function loadReport() {
  const reportPath = path.join(__dirname, 'fetch-report.json');
  if (fs.existsSync(reportPath)) {
    return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  }
  return { results: [], skipped: [], failures: [] };
}

function saveReport(report) {
  fs.writeFileSync(path.join(__dirname, 'fetch-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(__dirname, 'generated-locales-index.json'),
    JSON.stringify({ locales: report.results }, null, 2)
  );
}

async function main() {
  const lgas = await fetchLgaList();
  console.log(`Found ${lgas.length} real LGAs to process.`);

  const report = FORCE ? { results: [], skipped: [], failures: [] } : loadReport();
  const alreadyDone = new Set([
    ...report.results.map((r) => r.id),
    ...report.skipped,
    ...report.failures.map((f) => f.name),
  ]);

  for (let i = 0; i < lgas.length; i++) {
    const { lga_code_2021: code, lga_name_2021: name, state_name_2021: state } = lgas[i];
    const slug = slugify(name);

    if (SKIP_SLUGS.has(slug) || alreadyDone.has(name)) {
      console.log(`[${i + 1}/${lgas.length}] ${name} — already handled, skipping`);
      continue;
    }

    process.stdout.write(`[${i + 1}/${lgas.length}] ${name} (${state})... `);

    try {
      const geometry = await fetchLgaGeometry(code);
      if (!geometry) {
        console.log('no geometry, skipping');
        report.skipped.push(name);
        saveReport(report);
        continue;
      }
      const { latitude, longitude } = centroidOf(geometry);

      await sleep(DELAY_MS);

      const suburbData = await fetchSuburbs(geometry);
      if (!suburbData.features || suburbData.features.length === 0) {
        console.log('0 suburbs, skipping');
        report.skipped.push(name);
        saveReport(report);
        continue;
      }

      const outFile = `${slug}.json`;
      fs.writeFileSync(path.join(__dirname, outFile), JSON.stringify(suburbData));

      report.results.push({
        id: slug,
        name,
        latitude: Math.round(latitude * 10000) / 10000,
        longitude: Math.round(longitude * 10000) / 10000,
        type: 'polygon',
        url: `https://raw.githubusercontent.com/JoeHarrold0/locale-data/main/${outFile}`,
      });
      saveReport(report);
      console.log(`${suburbData.features.length} suburbs saved`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      report.failures.push({ name, error: err.message });
      saveReport(report);
    }

    await sleep(DELAY_MS);
  }

  console.log(
    `\nDone. Saved ${report.results.length}, skipped ${report.skipped.length}, failed ${report.failures.length}.`
  );
}

main();
