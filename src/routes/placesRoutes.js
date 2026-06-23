const express = require('express');
const router = express.Router();
const { placesAutocomplete, placeDetails } = require('../controllers/placesController');

// GET /api/places/autocomplete - server-side proxy for Google Places autocomplete
router.get('/autocomplete', placesAutocomplete);

// GET /api/places/details - resolve a chosen prediction to coordinates
router.get('/details', placeDetails);

module.exports = router;
