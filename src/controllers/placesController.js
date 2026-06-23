// Server-side proxy for the Google Places API (New).
//
// SECURITY: the Google key lives ONLY in process.env.GOOGLE_PLACES_KEY and is
// never sent to the client. The UserApp talks to these endpoints; this server is
// the only thing that ever holds or transmits the key. Do NOT echo the key back
// in any response or log line.

const PLACES_BASE = 'https://places.googleapis.com/v1';

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
