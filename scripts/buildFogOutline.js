// Builds the Australia fog-of-war outline used by the map's fog layer
// (locale/data/auBoundary.json, referenced from app/(tabs)/map.tsx).
//
// Uses a convex hull of the coastline, inflated outward for a sea margin,
// rather than tracing the coastline itself: an earlier version that traced
// the real coastline produced jagged artifacts in complex areas (Moreton
// Bay/Brisbane River) and excluded near-shore islands too small to model
// individually (e.g. North Stradbroke). A convex hull can't self-intersect
// or produce jagged edges, and it automatically swallows every near-shore
// island without modelling any of them - anything inside the hull just
// doesn't need its own point.
//
// Self-contained: fetches the raw ABS national boundary itself rather than
// depending on a pre-cached copy (that raw file is ~66MB at 1.66M points -
// not worth keeping checked into the repo when it's this cheap to re-fetch).
//
// Run: node buildFogOutline.js

const fs = require('fs');
const path = require('path');

// Core continent + Tasmania + near-shore islands. Deliberately excludes far
// external territories (Christmas Island ~105.7E, Cocos Islands ~96.8E,
// Norfolk Island ~167.9E) - including those would balloon the hull across
// thousands of km of empty ocean between them and the mainland.
const BOUNDS = { minLat: -45, maxLat: -9, minLng: 110, maxLng: 155 };

const INFLATE_FACTOR = 1.12; // ~12% outward from centroid - a generous sea margin without ballooning too far

// Where the app actually reads this from - write there directly so there's
// no separate "now copy it into the app repo" step to forget.
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'locale', 'data', 'auBoundary.json');

async function fetchAusBoundaryPoints() {
  const url =
    'https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/AUS/FeatureServer/0/query?' +
    'where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json';
  const res = await fetch(url);
  const data = await res.json();
  const feature = data.features.find((f) => f.geometry);

  const points = [];
  for (const ring of feature.geometry.rings) {
    for (const [lng, lat] of ring) {
      if (lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat && lng >= BOUNDS.minLng && lng <= BOUNDS.maxLng) {
        points.push([lng, lat]);
      }
    }
  }
  return points;
}

// Andrew's monotone chain convex hull. Points as [x, y] ([lng, lat] here).
function convexHull(points) {
  const pts = [...new Set(points.map((p) => p.join(',')))]
    .map((s) => s.split(',').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  upper.pop();
  lower.pop();
  return [...lower, ...upper];
}

function inflateFromCentroid(hull, factor) {
  const cLng = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const cLat = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  return hull.map(([lng, lat]) => [cLng + (lng - cLng) * factor, cLat + (lat - cLat) * factor]);
}

async function main() {
  console.log('Fetching Australia national boundary from ABS...');
  const points = await fetchAusBoundaryPoints();
  console.log(`Loaded ${points.length} coastline points within bounds.`);

  const hull = convexHull(points);
  console.log(`Convex hull: ${hull.length} points.`);

  const inflated = inflateFromCentroid(hull, INFLATE_FACTOR);

  const geometry = { type: 'Polygon', coordinates: [[...inflated, inflated[0]]] };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(geometry));
  console.log(`Saved ${OUTPUT_PATH} (${inflated.length + 1} points).`);
}

main();
