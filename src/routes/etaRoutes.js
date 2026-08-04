const express = require('express');
const router = express.Router();
const etaController = require('../controllers/etaController');
const { protect } = require('../middleware/auth');

// Calculate ETA for a specific vehicle and route
router.post('/calculate', protect, etaController.calculateVehicleETA);

// Get ETA for a vehicle on a specific route
router.get('/vehicle/:vehicleId/route/:routeId', protect, etaController.getVehicleETAByRoute);

// Get ETAs for all vehicles on a route
router.get('/route/:routeId/all-vehicles', protect, etaController.getRouteETAs);

module.exports = router;
