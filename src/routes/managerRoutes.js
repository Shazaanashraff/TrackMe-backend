const express = require('express');
const router = express.Router();
const {
  createVehicleAccountRequest,
  getManagerAssignableRoutes,
  updateRouteQr,
  getManagerVehicleById,
  getManagerVehicles,
  getManagerDashboard,
  getMyRequests,
  requestVehicleDelete,
  resetVehicleAccountPassword,
  updateManagerVehicle
} = require('../controllers/managerController');
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


// QR Attendance (see docs/features/qr-attendance/QR_SYSTEM.md)
router.get('/attendance', getManagerAttendance);
router.patch('/routes/:routeId/qr', updateRouteQr);

module.exports = router;
