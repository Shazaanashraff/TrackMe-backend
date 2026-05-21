const express = require('express');
const router = express.Router();
const {
  registerBus,
  getBusesByRoute,
  getAllRoutes,
  getMyBus,
  getBusById,
  updateBus,
  deleteBus,
  getAllBuses,
  updateMaintenanceStatus,
  getBusesStats
} = require('../controllers/busController');
const {
  validateCreateBus,
  validateUpdateBus,
  validateBusId
} = require('../middleware/validators');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { protect, requireDriver } = require('../middleware/auth');

// POST /api/bus/register - Register bus (driver only)
router.post('/register', protect, requireDriver, validateCreateBus, handleValidationErrors, registerBus);

// GET /api/bus/routes - Get all active routes
router.get('/routes', getAllRoutes);

// GET /api/bus/stats/overview - Get bus statistics
router.get('/stats/overview', getBusesStats);

// GET /api/bus/list/all - Get all buses (paginated)
router.get('/list/all', getAllBuses);

// GET /api/bus/my-bus - Get driver's bus (driver only)
router.get('/my-bus', protect, requireDriver, getMyBus);

// GET /api/bus/route/:routeId - Get buses by route
router.get('/route/:routeId', getBusesByRoute);

// GET /api/bus/:busId - Get single bus by ID
router.get('/:busId', validateBusId, handleValidationErrors, getBusById);

// PUT /api/bus/:busId - Update bus
router.put('/:busId', protect, validateUpdateBus, handleValidationErrors, updateBus);

// PATCH /api/bus/:busId/maintenance - Update maintenance status
router.patch('/:busId/maintenance', protect, updateMaintenanceStatus);

// DELETE /api/bus/:busId - Soft delete bus
router.delete('/:busId', protect, deleteBus);

module.exports = router;
