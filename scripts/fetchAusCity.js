const fs = require('fs');

async function fetchAusCity(lgaSearchName, outputFileName) {
  console.log(`Finding LGA boundary for "${lgaSearchName}"...`);

  const lgaUrl = `https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/LGA/FeatureServer/0/query?where=${encodeURIComponent(`lga_name_2021 LIKE '${lgaSearchName}%'`)}&outFields=*&f=json`;
  const lgaResponse = await fetch(lgaUrl);
  const lgaData = await lgaResponse.json();

  if (!lgaData.features || lgaData.features.length === 0) {
    console.log(`Could not find LGA matching "${lgaSearchName}".`);
    return;
  }

  console.log(`Found: ${lgaData.features[0].attributes.lga_name_2021}`);

  const brisbaneGeometry = lgaData.features[0].geometry;
  brisbaneGeometry.spatialReference = lgaData.spatialReference;

  const suburbUrl = `https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/SAL/FeatureServer/0/query`;

  const params = new URLSearchParams();
  params.append('where', '1=1');
  params.append('outFields', '*');
  params.append('geometry', JSON.stringify(brisbaneGeometry));
  params.append('geometryType', 'esriGeometryPolygon');
  params.append('spatialRel', 'esriSpatialRelIntersects');
  params.append('f', 'geojson');

  const suburbResponse = await fetch(suburbUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const suburbData = await suburbResponse.json();

  if (!suburbData.features) {
    console.log('Error from server:', JSON.stringify(suburbData, null, 2));
    return;
  }

  fs.writeFileSync(`./${outputFileName}`, JSON.stringify(suburbData, null, 2));
  console.log(`Saved ${suburbData.features.length} suburbs to ${outputFileName}.`);
}

const lgaSearchName = process.argv[2];
const outputFileName = process.argv[3];

if (!lgaSearchName || !outputFileName) {
  console.log('Usage: node fetchAusCity.js "LGA Search Name" outputFileName.json');
} else {
  fetchAusCity(lgaSearchName, outputFileName);
}