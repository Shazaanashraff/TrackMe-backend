const express = require('express');
const router = express.Router();
const { planTransit } = require('../controllers/transitController');

// GET /api/transit/plan - real public-transit directions (Google Routes API, buses)
router.get('/plan', planTransit);

module.exports = router;
