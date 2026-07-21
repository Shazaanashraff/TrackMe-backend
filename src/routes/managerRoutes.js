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
const {
  getOwnedRoutes,
  updateRoutePrivacy,
  updateRouteQr,
  rotateRoomKey,
  revealRoomKey,
  getRouteJoinRequests,
  decideJoinRequest,
  getRouteMembers,
  revokeRouteMember
} = require('../controllers/managerPrivateRoutesController');
const { getManagerAttendance } = require('../controllers/managerAttendanceController');
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

// Private Routes (room-key / PIN) — see PRIVATE_ROUTES_PLAN.md §5.1
router.get('/owned-routes', getOwnedRoutes);
router.patch('/routes/:routeId/privacy', updateRoutePrivacy);
router.post('/routes/:routeId/room-key/rotate', rotateRoomKey);
router.get('/routes/:routeId/room-key', revealRoomKey);
router.get('/routes/:routeId/join-requests', getRouteJoinRequests);
router.patch('/join-requests/:id/decision', decideJoinRequest);
router.get('/routes/:routeId/members', getRouteMembers);
router.delete('/routes/:routeId/members/:userId', revokeRouteMember);

// QR Attendance (see docs/features/qr-attendance/QR_SYSTEM.md)
router.get('/attendance', getManagerAttendance);
router.patch('/routes/:routeId/qr', updateRouteQr);

module.exports = router;
