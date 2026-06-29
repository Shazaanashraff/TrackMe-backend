const request = require('supertest');
const app = require('../../src/server');

// These tests exercise the Places proxy's guards WITHOUT calling Google:
// short input is short-circuited, missing placeId is rejected, and a missing
// server key returns 503. None of these paths reach places.googleapis.com.
describe('Places proxy guards (no upstream calls)', () => {
  it('returns an empty list for short input without calling Google', async () => {
    const res = await request(app).get('/api/places/autocomplete?input=a');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, count: 0, data: [] });
  });

  it('rejects place details with no placeId', async () => {
    const res = await request(app).get('/api/places/details');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 503 when the server key is not configured', async () => {
    const original = process.env.GOOGLE_PLACES_KEY;
    delete process.env.GOOGLE_PLACES_KEY;
    try {
      const res = await request(app).get('/api/places/autocomplete?input=colombo');
      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
    } finally {
      if (original !== undefined) process.env.GOOGLE_PLACES_KEY = original;
    }
  });

  it('never leaks the key in a response body', async () => {
    const original = process.env.GOOGLE_PLACES_KEY;
    process.env.GOOGLE_PLACES_KEY = 'SECRET-TEST-KEY-123';
    try {
      const res = await request(app).get('/api/places/autocomplete?input=x'); // short -> no upstream
      expect(JSON.stringify(res.body)).not.toContain('SECRET-TEST-KEY-123');
    } finally {
      process.env.GOOGLE_PLACES_KEY = original;
    }
  });
});

// Reverse geocode: name derivation + guards. `fetch` is mocked so no real Google/OSM
// calls are made; we only assert how the controller shapes the response.
describe('Places reverse geocode', () => {
  it('rejects invalid coordinates without calling upstream', async () => {
    const res = await request(app).get('/api/places/reverse?lat=abc&lng=10');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('derives a short name from the first segment of the resolved address', async () => {
    const original = process.env.GOOGLE_PLACES_KEY;
    process.env.GOOGLE_PLACES_KEY = 'test-key';
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      // Google Geocoding "disabled" -> fall through to the OSM fallback.
      if (String(url).includes('maps.googleapis.com')) {
        return { ok: true, json: async () => ({ status: 'ZERO_RESULTS' }) };
      }
      return {
        ok: true,
        json: async () => ({ display_name: 'Janadhipathi Mawatha, Fort, Colombo, Sri Lanka' }),
      };
    });
    try {
      const res = await request(app).get('/api/places/reverse?lat=6.9344&lng=79.8428');
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Janadhipathi Mawatha');
      expect(res.body.data.address).toBe('Janadhipathi Mawatha, Fort, Colombo, Sri Lanka');
    } finally {
      fetchSpy.mockRestore();
      process.env.GOOGLE_PLACES_KEY = original;
    }
  });

  it('derives a precise name from Google address_components when Geocoding is enabled', async () => {
    const original = process.env.GOOGLE_PLACES_KEY;
    process.env.GOOGLE_PLACES_KEY = 'test-key';
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      // Geocoding API enabled -> OK. We must NOT fall through to OSM.
      if (String(url).includes('maps.googleapis.com')) {
        return {
          ok: true,
          json: async () => ({
            status: 'OK',
            results: [
              {
                place_id: 'gp1',
                // formatted_address leads with a plus-code -> the OLD code would
                // have surfaced that. The new code must prefer the route component.
                formatted_address: 'WMQX+2R, Pathanwatta Rd, Kaduwela, Sri Lanka',
                address_components: [
                  { long_name: 'WMQX+2R', types: ['plus_code'] },
                  { long_name: 'Pathanwatta Road', types: ['route'] },
                  { long_name: 'Atalgoda', types: ['neighborhood', 'political'] },
                  { long_name: 'Kaduwela', types: ['locality', 'political'] },
                ],
              },
            ],
          }),
        };
      }
      throw new Error('OSM should not be called when Google returns OK');
    });
    try {
      const res = await request(app).get('/api/places/reverse?lat=6.9356&lng=79.9847');
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Pathanwatta Road');
      expect(res.body.data.placeId).toBe('gp1');
    } finally {
      fetchSpy.mockRestore();
      process.env.GOOGLE_PLACES_KEY = original;
    }
  });

  it('prefers the structured road name over the coarse suburb in display_name', async () => {
    const original = process.env.GOOGLE_PLACES_KEY;
    process.env.GOOGLE_PLACES_KEY = 'test-key';
    let osmUrl = '';
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        // Geocoding API not enabled on the key -> OSM fallback.
        return { ok: true, json: async () => ({ status: 'REQUEST_DENIED' }) };
      }
      osmUrl = String(url);
      return {
        ok: true,
        json: async () => ({
          // display_name leads with the suburb, which is what produced the bug.
          display_name: 'Atalgoda, Kadawatha, Gampaha District, Sri Lanka',
          address: { road: 'Pathanwatta Rd', suburb: 'Atalgoda', town: 'Kadawatha' },
        }),
      };
    });
    try {
      const res = await request(app).get('/api/places/reverse?lat=7.0&lng=79.95');
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Pathanwatta Rd');
      // We asked Nominatim for road-level detail + the structured address object.
      expect(osmUrl).toContain('zoom=18');
      expect(osmUrl).toContain('addressdetails=1');
    } finally {
      fetchSpy.mockRestore();
      process.env.GOOGLE_PLACES_KEY = original;
    }
  });

  it('falls back to suburb when the point is not on a named road', async () => {
    const original = process.env.GOOGLE_PLACES_KEY;
    process.env.GOOGLE_PLACES_KEY = 'test-key';
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { ok: true, json: async () => ({ status: 'REQUEST_DENIED' }) };
      }
      return {
        ok: true,
        json: async () => ({
          display_name: 'Atalgoda, Kadawatha, Sri Lanka',
          address: { suburb: 'Atalgoda', town: 'Kadawatha' },
        }),
      };
    });
    try {
      const res = await request(app).get('/api/places/reverse?lat=7.0&lng=79.95');
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Atalgoda');
    } finally {
      fetchSpy.mockRestore();
      process.env.GOOGLE_PLACES_KEY = original;
    }
  });

  it('falls back to a generic name and coordinate label when nothing resolves', async () => {
    const original = process.env.GOOGLE_PLACES_KEY;
    process.env.GOOGLE_PLACES_KEY = 'test-key';
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('maps.googleapis.com')) {
        return { ok: true, json: async () => ({ status: 'ZERO_RESULTS' }) };
      }
      return { ok: true, json: async () => ({}) }; // OSM: no display_name
    });
    try {
      const res = await request(app).get('/api/places/reverse?lat=6.9&lng=79.9');
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Pinned location');
      expect(res.body.data.address).toBe('6.90000, 79.90000');
    } finally {
      fetchSpy.mockRestore();
      process.env.GOOGLE_PLACES_KEY = original;
    }
  });
});
