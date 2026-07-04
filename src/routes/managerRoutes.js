const express = require('express');
const router = express.Router();
const {
  createBusAccountRequest,
  getManagerAssignableRoutes,
  getManagerBusById,
  getManagerBuses,
  getManagerBusLocation,
  getManagerCustomRoutes,
  getManagerDashboard,
  getManagerRouteChangeRequests,
  getMyRequests,
  nameCustomRoute,
  requestBusDelete,
  resetBusAccountPassword,
  resolveRouteChangeRequest,
  updateManagerBus
} = require('../controllers/managerController');
const { protect, requireManager } = require('../middleware/auth');

router.use(protect, requireManager);

router.get('/dashboard', getManagerDashboard);
router.get('/buses', getManagerBuses);
router.get('/routes', getManagerAssignableRoutes);
router.get('/requests', getMyRequests);
router.post('/bus-accounts', createBusAccountRequest);
router.patch('/bus-accounts/:busId/reset-password', resetBusAccountPassword);
router.get('/buses/:busId', getManagerBusById);
router.put('/buses/:busId', updateManagerBus);
router.post('/buses/:busId/delete-request', requestBusDelete);
router.get('/buses/:busId/location', getManagerBusLocation);
router.get('/custom-routes', getManagerCustomRoutes);
router.patch('/custom-routes/:routeId/name', nameCustomRoute);
router.get('/route-change-requests', getManagerRouteChangeRequests);
router.patch('/route-change-requests/:id/resolve', resolveRouteChangeRequest);

module.exports = router;
