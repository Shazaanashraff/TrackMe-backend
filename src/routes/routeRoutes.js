const express = require('express');
const router = express.Router();
const {
  createRoute,
  getAllRoutes,
  getRouteById,
  updateRoute,
  deleteRoute,
  getRoutesPaginated,
  toggleRouteStatus,
  getRoutesStats
} = require('../controllers/routeController');
const {
  validateCreateRoute,
  validateUpdateRoute,
  validateRouteId
} = require('../middleware/validators');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { protect, requireManagerOrAbove } = require('../middleware/auth');

// Manager-or-super-admin routes with basic protect middleware

// POST /api/routes - Create new route (admin)
router.post('/', protect, requireManagerOrAbove, validateCreateRoute, handleValidationErrors, createRoute);

// GET /api/routes - Get all routes (with filters)
router.get('/', getAllRoutes);

// GET /api/routes/stats/overview - Get routes statistics
router.get('/stats/overview', getRoutesStats);

// GET /api/routes/:routeId - Get single route
router.get('/:routeId', validateRouteId, handleValidationErrors, getRouteById);

// PUT /api/routes/:routeId - Update route (admin)
router.put('/:routeId', protect, requireManagerOrAbove, validateUpdateRoute, handleValidationErrors, updateRoute);

// PATCH /api/routes/:routeId/toggle - Toggle route status
router.patch('/:routeId/toggle', protect, requireManagerOrAbove, toggleRouteStatus);

// DELETE /api/routes/:routeId - Delete route (admin)
router.delete('/:routeId', protect, requireManagerOrAbove, deleteRoute);

module.exports = router;
