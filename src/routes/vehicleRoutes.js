const express = require('express');
const router = express.Router();
const {
  registerVehicle,
  getVehiclesByRoute,
  getAllRoutes,
  getStops,
  planJourney,
  getMyVehicle,
  getVehicleById,
  updateVehicle,
  deleteVehicle,
  getAllVehicles,
  updateMaintenanceStatus,
  getVehiclesStats,
} = require('../controllers/vehicleController');
const {
  validateCreateVehicle,
  validateUpdateVehicle,
  validateVehicleId
} = require('../middleware/validators');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { protect, requireDriver, requireRoles, optionalAuth } = require('../middleware/auth');
const { getRoutePath } = require('../controllers/routeGeometryController');
const { getWalkPath } = require('../controllers/walkController');

// POST /api/vehicle/register - Register vehicle (driver only)
router.post('/register', protect, requireDriver, validateCreateVehicle, handleValidationErrors, registerVehicle);

// GET /api/vehicle/stops - Flat list of unique stops (for From/To autocomplete)
router.get('/stops', getStops);

// GET /api/vehicle/routes - Get all active routes
router.get('/routes', getAllRoutes);

// GET /api/vehicle/routes/plan - Direct routes serving a from -> to trip
router.get('/routes/plan', planJourney);

// GET /api/vehicle/routes/:routeId/path - road-following polyline for a route (cached)
router.get('/routes/:routeId/path', getRoutePath);

// GET /api/vehicle/walk - real walking polyline between two points (one call per confirm)
router.get('/walk', getWalkPath);

// GET /api/vehicle/stats/overview - Get vehicle statistics
router.get('/stats/overview', getVehiclesStats);

// GET /api/vehicle/list/all - Get all vehicles (paginated)
router.get('/list/all', getAllVehicles);

// GET /api/vehicle/my-vehicle - Get driver's vehicle (driver only)
router.get('/my-vehicle', protect, requireDriver, getMyVehicle);

// GET /api/vehicle/route/:routeId - Get vehicles by route
router.get('/route/:routeId', optionalAuth, getVehiclesByRoute);

// GET /api/vehicle/:vehicleId - Get single vehicle by ID
router.get('/:vehicleId', validateVehicleId, handleValidationErrors, getVehicleById);

// PUT /api/vehicle/:vehicleId - Update vehicle. Fine-grained ownership (own vehicle
// vs. assigned fleet vs. any) still lives in the controller; this middleware is the
// defense-in-depth backstop that keeps a rider (or any future role) out regardless
// of how that controller logic evolves.
router.put(
  '/:vehicleId',
  protect,
  requireRoles('driver', 'admin', 'super-admin'),
  validateUpdateVehicle,
  handleValidationErrors,
  updateVehicle
);

// PATCH /api/vehicle/:vehicleId/maintenance - Update maintenance status
router.patch('/:vehicleId/maintenance', protect, updateMaintenanceStatus);

// DELETE /api/vehicle/:vehicleId - Soft delete vehicle
router.delete('/:vehicleId', protect, deleteVehicle);

module.exports = router;
