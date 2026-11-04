#!/usr/bin/env node
// Does a matched custom route really stay on roads, and out of houses?
//
// A route check that asks the map matcher "is this on your road network?" proves nothing:
// the matcher agrees with itself. This script judges the result against a SECOND, independent
// source - the raw OpenStreetMap road and building outlines fetched straight from Overpass:
//
//   1. Simulate a driver: take a real road (any drivable A -> B), then produce several
//      "rides" of noisy GPS with the errors a phone really makes (a few metres of random
//      error, a slowly drifting bias, a few big multipath jumps, and occasional drift
//      sideways towards the buildings).
//   2. Run each ride through the production pipeline (cleanTrace -> OSRM match) and then
//      the production consensus (routeConsensus.buildConsensus), exactly as the server does.
//   3. Fetch the area's OSM roads and buildings from Overpass and measure:
//        - raw GPS : how many fixes fall inside a building / far from any road
//        - matched : how many points of the final line fall inside a building / off any road
//        - how closely the final line follows the real road that was driven
//
// Usage:  node scripts/verify-route-geometry.js [--from lat,lng] [--to lat,lng] [--rides 5] [--seed 7]
// Network: router.project-osrm.org (or MAP_MATCH_URL) and overpass-api.de. Development tool only;
// it is slow on the public demo server (10 points per request).

const path = require('path');
const { matchRawTrace, cleanTrace } = require('../src/utils/mapMatch');
const { buildConsensus } = require('../src/utils/routeConsensus');
const geo = require('../src/utils/geo');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const parsePoint = (text) => {
  const [lat, lng] = text.split(',').map(Number);
  return { lat, lng };
};

// A drive through Colombo's residential back streets, where houses sit close to the road.
const FROM = parsePoint(arg('from', '6.9022,79.8612'));
const TO = parsePoint(arg('to', '6.8895,79.8553'));
const RIDES = Number(arg('rides', 5));
let seed = Number(arg('seed', 7));

const OSRM = (process.env.MAP_MATCH_URL || 'https://router.project-osrm.org').replace(/\/$/, '');
const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
const M = 111320;
const lngScale = (lat) => Math.cos((lat * Math.PI) / 180);

async function drivableRoad(a, b) {
  const url = `${OSRM}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full`;
  const body = await (await fetch(url)).json();
  if (body.code !== 'Ok') throw new Error(`route: ${body.code}`);
  return body.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
}

// One simulated ride along `road`: a fix every ~12 m with realistic phone GPS error.
function simulateRide(road, rideIndex) {
  const spaced = geo.resamplePolyline(road, 12);
  let biasN = 0;
  let biasE = 0;
  return spaced.map((p, i) => {
    // Slowly wandering bias (what a poor satellite fix does), not independent white noise.
    biasN = biasN * 0.97 + gauss() * 0.9;
    biasE = biasE * 0.97 + gauss() * 0.9;
    let n = gauss() * 4 + biasN;
    let e = gauss() * 4 + biasE;
    // Now and then a multipath jump of 15-30 m - the case that puts a fix in somebody's garden.
    if (rnd() < 0.015) {
      const jump = 15 + rnd() * 15;
      const angle = rnd() * 2 * Math.PI;
      n += jump * Math.cos(angle);
      e += jump * Math.sin(angle);
    }
    return {
      lat: p.lat + n / M,
      lng: p.lng + e / (M * lngScale(p.lat)),
      t: 1_700_000_000_000 + rideIndex * 86_400_000 + i * 2500,
      acc: 5 + rnd() * 20
    };
  });
}

// --- independent OSM data ---------------------------------------------------------------
// The public Overpass servers are shared and often busy (502/504): try each mirror, twice.
const OVERPASS_MIRRORS = [
  OVERPASS,
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

async function overpass(query) {
  let lastError = 'no attempt';
  for (let round = 0; round < 2; round += 1) {
    for (const url of OVERPASS_MIRRORS) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'pingo-route-verify/1.0' },
          body: `data=${encodeURIComponent(query)}`
        });
        if (res.ok) return await res.json(); // eslint-disable-line no-await-in-loop
        lastError = `${url} -> ${res.status}`;
      } catch (error) {
        lastError = `${url} -> ${error.message}`;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw new Error(`overpass unavailable (${lastError})`);
}

async function osmAround(road) {
  const lats = road.map((p) => p.lat);
  const lngs = road.map((p) => p.lng);
  const pad = 0.003;
  const bbox = [Math.min(...lats) - pad, Math.min(...lngs) - pad, Math.max(...lats) + pad, Math.max(...lngs) + pad].join(',');
  const data = await overpass(`[out:json][timeout:60];(
    way["building"](${bbox});
    way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road)$"](${bbox});
  );out geom;`);
  const buildings = [];
  const roads = [];
  for (const el of data.elements) {
    if (!el.geometry) continue;
    const pts = el.geometry.map((g) => ({ lat: g.lat, lng: g.lon }));
    if (el.tags?.building) buildings.push(pts);
    else roads.push(pts);
  }
  return { buildings, roads };
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.lat > pt.lat) !== (b.lat > pt.lat)
      && pt.lng < ((b.lng - a.lng) * (pt.lat - a.lat)) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}

// Distance (m) from a point to a polyline, flat-earth - fine at these ranges.
function distanceToLine(pt, line) {
  const kx = M * lngScale(pt.lat);
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i += 1) {
    const ax = (line[i].lng - pt.lng) * kx;
    const ay = (line[i].lat - pt.lat) * M;
    const bx = (line[i + 1].lng - pt.lng) * kx;
    const by = (line[i + 1].lat - pt.lat) * M;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

const bboxOf = (poly) => poly.reduce((b, p) => ({
  minLat: Math.min(b.minLat, p.lat), maxLat: Math.max(b.maxLat, p.lat),
  minLng: Math.min(b.minLng, p.lng), maxLng: Math.max(b.maxLng, p.lng)
}), { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 });

function insideAnyBuilding(pt, buildings) {
  return buildings.some((b) => {
    const bb = b.bbox;
    if (pt.lat < bb.minLat || pt.lat > bb.maxLat || pt.lng < bb.minLng || pt.lng > bb.maxLng) return false;
    return pointInPolygon(pt, b.poly);
  });
}

function distanceToNearestRoad(pt, roads) {
  let best = Infinity;
  for (const r of roads) {
    const bb = r.bbox;
    // Skip roads whose box is clearly farther than the best found so far (~0.0004 deg = 45 m).
    if (pt.lat < bb.minLat - 0.0004 || pt.lat > bb.maxLat + 0.0004
      || pt.lng < bb.minLng - 0.0004 || pt.lng > bb.maxLng + 0.0004) continue;
    best = Math.min(best, distanceToLine(pt, r.line));
    if (best < 1) break;
  }
  return best;
}

function judge(label, points, osm) {
  const sampled = geo.resamplePolyline(points, 5);
  let inBuilding = 0;
  let offRoad = 0;
  let worstOffRoad = 0;
  for (const p of sampled) {
    if (insideAnyBuilding(p, osm.buildings)) inBuilding += 1;
    const d = distanceToNearestRoad(p, osm.roads);
    worstOffRoad = Math.max(worstOffRoad, d);
    if (d > 15) offRoad += 1;
  }
  const n = sampled.length;
  return {
    label,
    points: n,
    insideBuildings: inBuilding,
    insideBuildingsPct: Number(((inBuilding / n) * 100).toFixed(2)),
    farFromAnyRoadPct: Number(((offRoad / n) * 100).toFixed(2)),
    worstDistanceFromRoadM: Math.round(worstOffRoad)
  };
}

(async () => {
  console.log(`Driving ${FROM.lat},${FROM.lng} -> ${TO.lat},${TO.lng} with ${RIDES} simulated rides`);
  const road = await drivableRoad(FROM, TO);
  const lengthM = geo.polylineLengthMeters(road);
  console.log(`Real road: ${Math.round(lengthM)} m, ${road.length} vertices`);

  const rawRides = Array.from({ length: RIDES }, (_, i) => simulateRide(road, i));

  console.log('Fetching OpenStreetMap roads and buildings (independent data)...');
  const osmRaw = await osmAround(road);
  const osm = {
    buildings: osmRaw.buildings.map((poly) => ({ poly, bbox: bboxOf(poly) })),
    roads: osmRaw.roads.map((line) => ({ line, bbox: bboxOf(line) }))
  };
  console.log(`  ${osm.buildings.length} building outlines, ${osm.roads.length} road ways`);

  const rows = [];
  rows.push({ ...judge('raw GPS (ride 1, before any cleaning)', rawRides[0], osm) });

  const matched = [];
  const started = Date.now();
  for (let i = 0; i < rawRides.length; i += 1) {
    process.stdout.write(`  matching ride ${i + 1}/${RIDES}... `);
    const t0 = Date.now();
    const out = await matchRawTrace(rawRides[i]);
    console.log(`${out.coords.length} points, confidence ${out.confidence.toFixed(2)}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    matched.push({ id: i, coords: out.coords, stops: [], durationSec: 600 });
  }

  const consensus = buildConsensus(matched);
  if (!consensus) throw new Error('no consensus');

  rows.push(judge('matched ride 1', matched[0].coords, osm));
  rows.push(judge(`FINAL ROUTE (consensus of ${RIDES} rides)`, consensus.coords, osm));

  console.table(rows);

  const follow = geo.coverageFraction(geo.resamplePolyline(road, 10), consensus.coords, 20);
  const stay = geo.coverageFraction(geo.resamplePolyline(consensus.coords, 10), road, 20);
  const final = rows[rows.length - 1];
  const summary = {
    trueRoadMeters: Math.round(lengthM),
    finalLineMeters: Math.round(geo.polylineLengthMeters(consensus.coords)),
    consensusConfidence: consensus.confidence,
    consensusWarning: consensus.warning || 'none',
    trueRoadCoveredByFinalLine_within20m: `${Math.round(follow * 100)}%`,
    finalLineWithin20mOfTrueRoad: `${Math.round(stay * 100)}%`,
    secondsTotal: Math.round((Date.now() - started) / 1000)
  };
  console.log(summary);

  const ok = final.insideBuildings === 0 && final.farFromAnyRoadPct <= 1 && follow >= 0.95 && stay >= 0.95;
  console.log(ok ? 'PASS: the final route stays on roads and out of buildings.' : 'FAIL: see the table above.');
  process.exit(ok ? 0 : 1);
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(2);
});

void path;
