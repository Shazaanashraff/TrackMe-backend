const express = require('express');
const router = express.Router();
const {
  createVehicleAccountRequest,
  getManagerAssignableRoutes,
  getManagerVehicleById,
  getManagerVehicles,
  getManagerVehicleLocation,
  getManagerDashboard,
  getMyRequests,
  requestVehicleDelete,
  resetVehicleAccountPassword,
  updateManagerVehicle
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
router.get('/vehicles', getManagerVehicles);
router.get('/routes', getManagerAssignableRoutes);
router.get('/requests', getMyRequests);
router.post('/vehicle-accounts', createVehicleAccountRequest);
router.patch('/vehicle-accounts/:vehicleId/reset-password', resetVehicleAccountPassword);
router.get('/vehicles/:vehicleId', getManagerVehicleById);
router.put('/vehicles/:vehicleId', updateManagerVehicle);
router.post('/vehicles/:vehicleId/delete-request', requestVehicleDelete);
router.get('/vehicles/:vehicleId/location', getManagerVehicleLocation);

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
