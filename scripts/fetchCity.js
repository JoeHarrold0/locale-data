const fs = require('fs');

async function tryPolygonApproach(cityName) {
  const query = `
    [out:json][timeout:60];
    area["name"="${cityName}"]["admin_level"~"^(6|8)$"]->.a;
    relation["admin_level"~"^(9|10)$"]["boundary"="administrative"](area.a);
    out geom;
  `;

  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': '*/*',
        'User-Agent': 'LocaleApp/1.0 (testing)',
      },
    body: `data=${encodeURIComponent(query)}`,
  });

  const text = await response.text();
  const data = JSON.parse(text);

  const validFeatures = (data.elements || []).filter(
    (el) => el.type === 'relation' && el.members && el.tags?.name
  );

  return validFeatures;
}

async function tryPointApproach(cityName) {
  const query = `
    [out:json][timeout:60];
    area["name"="${cityName}"]->.a;
    (
      relation["place"~"^(suburb|neighbourhood)$"](area.a);
      way["place"~"^(suburb|neighbourhood)$"](area.a);
      node["place"~"^(suburb|neighbourhood)$"](area.a);
    );
    out center;
  `;

  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': '*/*',
        'User-Agent': 'LocaleApp/1.0 (testing)',
      },
    body: `data=${encodeURIComponent(query)}`,
  });

  const text = await response.text();
  const data = JSON.parse(text);

  return (data.elements || []).filter((el) => el.tags?.name);
}

function relationToGeoJSON(element) {
  // Build a simple polygon from the "outer" way members of a relation.
  const outerWays = element.members.filter((m) => m.role === 'outer' && m.geometry);
  if (outerWays.length === 0) return null;

  // Just use the first outer way's points as a simplified boundary.
  // (Full multi-way stitching is more complex; this covers most simple suburbs.)
  const coordinates = outerWays[0].geometry.map((pt) => [pt.lon, pt.lat]);

  return {
    type: 'Feature',
    properties: { name: element.tags.name },
    geometry: {
      type: 'Polygon',
      coordinates: [coordinates],
    },
  };
}

function pointToCircleGeoJSON(element, radiusMeters = 800) {
  const center =
    element.type === 'node'
      ? { lat: element.lat, lon: element.lon }
      : element.center;

  if (!center) return null;

  // Approximate a circle as a 32-point polygon around the center.
  const points = [];
  const earthRadius = 6371000;
  for (let i = 0; i <= 32; i++) {
    const angle = (i / 32) * 2 * Math.PI;
    const dx = (radiusMeters * Math.cos(angle)) / earthRadius;
    const dy = (radiusMeters * Math.sin(angle)) / earthRadius;
    const lat = center.lat + (dy * 180) / Math.PI;
    const lon = center.lon + ((dx * 180) / Math.PI) / Math.cos((center.lat * Math.PI) / 180);
    points.push([lon, lat]);
  }

  return {
    type: 'Feature',
    properties: { name: element.tags.name },
    geometry: {
      type: 'Polygon',
      coordinates: [points],
    },
  };
}

async function fetchCity(cityName, outputFileName) {
  console.log(`Trying polygon approach for ${cityName}...`);
  const polygonResults = await tryPolygonApproach(cityName);

  let features = [];
  let approach = '';

  if (polygonResults.length > 5) {
    console.log(`Found ${polygonResults.length} polygon-based suburbs.`);
    features = polygonResults.map(relationToGeoJSON).filter(Boolean);
    approach = 'polygon';
  } else {
    console.log(`Polygon approach found only ${polygonResults.length}, trying point approach...`);
    const pointResults = await tryPointApproach(cityName);
    console.log(`Found ${pointResults.length} point-based suburbs.`);
    features = pointResults.map((el) => pointToCircleGeoJSON(el)).filter(Boolean);
    approach = 'circle';
  }

  const geojson = {
    type: 'FeatureCollection',
    approach,
    features,
  };

  fs.writeFileSync(`./${outputFileName}`, JSON.stringify(geojson, null, 2));
  console.log(`Saved ${features.length} features to ${outputFileName} using ${approach} approach.`);
}

const cityName = process.argv[2];
const outputFileName = process.argv[3];

if (!cityName || !outputFileName) {
  console.log('Usage: node fetchCity.js "City Name" outputFileName.json');
} else {
  fetchCity(cityName, outputFileName);
}