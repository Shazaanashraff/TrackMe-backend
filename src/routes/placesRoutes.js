const express = require('express');
const router = express.Router();
const { placesAutocomplete, placeDetails, reverseGeocode } = require('../controllers/placesController');

// GET /api/places/autocomplete - server-side proxy for Google Places autocomplete
router.get('/autocomplete', placesAutocomplete);

// GET /api/places/details - resolve a chosen prediction to coordinates
router.get('/details', placeDetails);

// GET /api/places/reverse - resolve a coordinate (dragged pin) to a street address
router.get('/reverse', reverseGeocode);

module.exports = router;
