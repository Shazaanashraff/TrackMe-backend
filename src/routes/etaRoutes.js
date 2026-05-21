const express = require('express');
const router = express.Router();
const etaController = require('../controllers/etaController');
const { protect } = require('../middleware/auth');

// Calculate ETA for a specific bus and route
router.post('/calculate', protect, etaController.calculateBusETA);

// Get ETA for a bus on a specific route
router.get('/bus/:busId/route/:routeId', protect, etaController.getBusETAByRoute);

// Get ETAs for all buses on a route
router.get('/route/:routeId/all-buses', protect, etaController.getRouteETAs);

module.exports = router;
