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
  verifyRoomKey,
  getMyPrivateRoutes,
  getMyJoinRequests,
  leavePrivateRoute
} = require('../controllers/routeAccessController');
const {
  validateCreateRoute,
  validateUpdateRoute,
  validateRouteId
} = require('../middleware/validators');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { protect, requireAdmin } = require('../middleware/auth');

// Admin only routes with basic protect middleware
// In production, add role-based middleware like requireAdmin

// POST /api/routes - Create new route (admin)
router.post('/', protect, requireAdmin, validateCreateRoute, handleValidationErrors, createRoute);

// GET /api/routes - Get all routes (with filters)
router.get('/', getAllRoutes);

// GET /api/routes/stats/overview - Get routes statistics
router.get('/stats/overview', getRoutesStats);

// Private Routes (room-key / PIN) — authenticated. Declared before the generic
// /:routeId routes below so these literal paths win. See PRIVATE_ROUTES_PLAN.md §5.2.
router.post('/join/verify', protect, verifyRoomKey);
router.get('/my-private', protect, getMyPrivateRoutes);
router.get('/my-requests', protect, getMyJoinRequests);

// GET /api/routes/:routeId - Get single route
router.get('/:routeId', validateRouteId, handleValidationErrors, getRouteById);

// PUT /api/routes/:routeId - Update route (admin)
router.put('/:routeId', protect, requireAdmin, validateUpdateRoute, handleValidationErrors, updateRoute);

// PATCH /api/routes/:routeId/toggle - Toggle route status
router.patch('/:routeId/toggle', protect, requireAdmin, toggleRouteStatus);

// DELETE /api/routes/:routeId - Delete route (admin)
router.delete('/:routeId', protect, requireAdmin, deleteRoute);

// DELETE /api/routes/:routeId/membership - User leaves a private route
router.delete('/:routeId/membership', protect, leavePrivateRoute);

module.exports = router;
