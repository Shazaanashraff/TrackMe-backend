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
const {
  getManagerDrivers,
  createManagerDriver,
  updateManagerDriver,
  resetManagerDriverPassword,
  getDriverEnrollmentKey,
  rotateDriverEnrollmentKey,
  deleteManagerDriver
} = require('../controllers/managerDriversController');
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


// Driver directory
router.get('/drivers', getManagerDrivers);
router.post('/drivers', createManagerDriver);
router.put('/drivers/:driverId', updateManagerDriver);
router.delete('/drivers/:driverId', deleteManagerDriver);
router.put('/drivers/:driverId/password', resetManagerDriverPassword);
router.get('/drivers/:driverId/enrollment-key', getDriverEnrollmentKey);
router.post('/drivers/:driverId/enrollment-key/rotate', rotateDriverEnrollmentKey);

// QR Attendance (see docs/features/qr-attendance/QR_SYSTEM.md)
router.get('/attendance', getManagerAttendance);
router.patch('/routes/:routeId/qr', updateRouteQr);

module.exports = router;
