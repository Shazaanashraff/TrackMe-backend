// Server-side proxy for the Google Places API (New).
//
// SECURITY: the Google key lives ONLY in process.env.GOOGLE_PLACES_KEY and is
// never sent to the client. The UserApp talks to these endpoints; this server is
// the only thing that ever holds or transmits the key. Do NOT echo the key back
// in any response or log line.

const PLACES_BASE = 'https://places.googleapis.com/v1';
const GEOCODE_BASE = 'https://maps.googleapis.com/maps/api/geocode/json';

// Bias predictions to Sri Lanka so the fleet's local stops/addresses rank first.
const REGION_CODES = ['lk'];

function getKey(res) {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) {
    res.status(503).json({
      success: false,
      message: 'Places lookup is not configured on the server (missing GOOGLE_PLACES_KEY).',
    });
    return null;
  }
  return key;
}

// GET /api/places/autocomplete?input=...&sessionToken=...
// Returns slim predictions; pass the same sessionToken through autocomplete +
// details so Google bills it as one session instead of per keystroke.
exports.placesAutocomplete = async (req, res) => {
  const key = getKey(res);
  if (!key) return;

  const input = String(req.query.input || '').trim();
  if (input.length < 2) {
    return res.status(200).json({ success: true, count: 0, data: [] });
  }

  try {
    const body = { input, includedRegionCodes: REGION_CODES };
    if (req.query.sessionToken) body.sessionToken = String(req.query.sessionToken);

    const gRes = await fetch(`${PLACES_BASE}/places:autocomplete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask':
          'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat',
      },
      body: JSON.stringify(body),
    });

    if (!gRes.ok) {
      const detail = await gRes.text();
      console.error(`[places] autocomplete upstream ${gRes.status}: ${detail.slice(0, 300)}`);
      return res.status(502).json({ success: false, message: 'Places autocomplete failed upstream.' });
    }

    const json = await gRes.json();
    const data = (json.suggestions || [])
      .map((s) => s.placePrediction)
      .filter(Boolean)
      .map((p) => ({
        placeId: p.placeId,
        primaryText: p.structuredFormat?.mainText?.text || p.text?.text || '',
        secondaryText: p.structuredFormat?.secondaryText?.text || '',
        fullText: p.text?.text || '',
      }));

    res.status(200).json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[places] autocomplete error:', err.message);
    res.status(500).json({ success: false, message: 'Places autocomplete error.' });
  }
};

// GET /api/places/details?placeId=...&sessionToken=...
// Resolves a chosen prediction to coordinates we can snap to the nearest stop.
exports.placeDetails = async (req, res) => {
  const key = getKey(res);
  if (!key) return;

  const placeId = String(req.query.placeId || '').trim();
  if (!placeId) {
    return res.status(400).json({ success: false, message: 'placeId is required.' });
  }

  try {
    const url = new URL(`${PLACES_BASE}/places/${encodeURIComponent(placeId)}`);
    if (req.query.sessionToken) url.searchParams.set('sessionToken', String(req.query.sessionToken));

    const gRes = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,location',
      },
    });

    if (!gRes.ok) {
      const detail = await gRes.text();
      console.error(`[places] details upstream ${gRes.status}: ${detail.slice(0, 300)}`);
      return res.status(502).json({ success: false, message: 'Place details failed upstream.' });
    }

    const p = await gRes.json();
    if (!p.location) {
      return res.status(404).json({ success: false, message: 'Place has no location.' });
    }

    res.status(200).json({
      success: true,
      data: {
        placeId: p.id,
        name: p.displayName?.text || '',
        address: p.formattedAddress || '',
        lat: p.location.latitude,
        lng: p.location.longitude,
      },
    });
  } catch (err) {
    console.error('[places] details error:', err.message);
    res.status(500).json({ success: false, message: 'Place details error.' });
  }
};

// Picks the most specific human-readable label from Google Geocoding results.
// A dragged pin almost always sits on a road or at a named place, so prefer a
// POI/premise/road name over the broad sublocality/town. Mirrors osmShortName so
// both providers yield the same precise-name behaviour (the Google path used to
// just take formatted_address.split(',')[0], which is often a plus-code or town).
function googleShortName(results) {
  const typeRank = [
    'point_of_interest', 'establishment', 'premise', 'route',
    'neighborhood', 'sublocality', 'sublocality_level_1', 'locality',
  ];
  // Scan results most-specific first; within each, pick the highest-ranked component.
  for (const want of typeRank) {
    for (const r of results) {
      for (const c of r.address_components || []) {
        if ((c.types || []).includes(want)) return c.long_name;
      }
    }
  }
  // Fall back to the first segment of the top result's formatted address.
  const top = results[0];
  return top?.formatted_address ? top.formatted_address.split(',')[0].trim() : null;
}

// Google Geocoding API reverse lookup. Returns a formatted address, or null when
// the API is not enabled / has no match (so we can fall back to another provider).
async function googleReverse(lat, lng, key) {
  const url = new URL(GEOCODE_BASE);
  url.searchParams.set('latlng', `${lat},${lng}`);
  url.searchParams.set('region', 'lk');
  url.searchParams.set('key', key);
  const gRes = await fetch(url);
  if (!gRes.ok) return null;
  const json = await gRes.json();
  if (json.status !== 'OK') {
    // REQUEST_DENIED means the Geocoding API isn't enabled on the key's project.
    if (json.status) console.warn(`[places] google reverse status ${json.status}`);
    return null;
  }
  const results = Array.isArray(json.results) ? json.results : [];
  const top = results[0];
  return top
    ? { placeId: top.place_id || 'reverse-geocode', address: top.formatted_address, name: googleShortName(results) }
    : null;
}

// Picks the most specific human-readable label from a Nominatim structured
// address. A dragged pin almost always sits on a road, so prefer the road/footway
// name; only fall back to broader areas (neighbourhood → suburb → town) when the
// point isn't on a named way. This avoids labelling a street pin with its coarse
// suburb (e.g. a pin on "Pathanwatta Rd" reading "Atalgoda").
function osmShortName(json) {
  const a = json.address || {};
  return (
    a.road ||
    a.pedestrian ||
    a.footway ||
    a.path ||
    json.name ||            // named POI/feature at the point
    a.neighbourhood ||
    a.suburb ||
    a.hamlet ||
    a.village ||
    a.town ||
    a.city ||
    (json.display_name ? json.display_name.split(',')[0].trim() : '') ||
    null
  );
}

// OpenStreetMap (Nominatim) reverse lookup — free, no key. Used as a fallback when
// Google Geocoding isn't available. Nominatim requires a descriptive User-Agent.
// zoom=18 + addressdetails=1 asks for building/road-level granularity and the
// structured `address` object so we can pick a precise short name.
async function osmReverse(lat, lng) {
  const url = new URL('https://nominatim.openstreetmap.org/reverse');
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lng));
  url.searchParams.set('zoom', '18');
  url.searchParams.set('addressdetails', '1');
  const gRes = await fetch(url, { headers: { 'User-Agent': 'TrackMe/1.0 (bus-tracking app)' } });
  if (!gRes.ok) return null;
  const json = await gRes.json();
  if (!json.display_name) return null;
  return { placeId: 'osm-reverse', address: json.display_name, name: osmShortName(json) };
}

// GET /api/places/reverse?lat=...&lng=...
// Reverse-geocodes a coordinate (e.g. a dragged map pin) to a street address.
// Tries Google Geocoding first, then OpenStreetMap, then a raw coordinate label.
exports.reverseGeocode = async (req, res) => {
  const key = getKey(res);
  if (!key) return;

  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ success: false, message: 'Valid lat and lng are required.' });
  }

  try {
    let hit = null;
    try { hit = await googleReverse(lat, lng, key); } catch (e) { console.warn('[places] google reverse error:', e.message); }
    if (!hit) {
      try { hit = await osmReverse(lat, lng); } catch (e) { console.warn('[places] osm reverse error:', e.message); }
    }

    // Short label for the From/To box. Prefer a provider-supplied precise name
    // (OSM's structured road/POI name); otherwise take the first segment of the
    // resolved address (Google's formatted_address is street-level there). Only
    // fall back to a generic label when nothing resolved.
    const name =
      hit?.name?.trim() ||
      (hit?.address ? hit.address.split(',')[0].trim() : '') ||
      'Pinned location';

    res.status(200).json({
      success: true,
      data: {
        placeId: hit?.placeId || 'reverse-geocode',
        name,
        // Final fallback: the raw coordinate so the UI always has something to show.
        address: hit?.address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        lat,
        lng,
      },
    });
  } catch (err) {
    console.error('[places] reverse error:', err.message);
    res.status(500).json({ success: false, message: 'Reverse geocode error.' });
  }
};
