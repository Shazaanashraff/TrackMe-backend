const express = require('express');
const router = express.Router();
const {
  createManagerVehicle,
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
  getOrganizationsForManager,
  createOrganizationForManager,
  getManagerDrivers,
  createManagerDriver,
  updateManagerDriver,
  resetManagerDriverPassword,
  getManagerDriverPassword,
  getDriverEnrollmentKey,
  rotateDriverEnrollmentKey,
  revertDriverEnrollmentKey,
  deleteManagerDriver
} = require('../controllers/managerDriversController');
const { getManagerAttendance } = require('../controllers/managerAttendanceController');
const { getManagerFleetLive } = require('../controllers/liveLocationController');
const {
  getManagerEnrollmentRequests,
  getManagerEnrollmentRequestCount,
  approveManagerEnrollmentRequest,
  rejectManagerEnrollmentRequest
} = require('../controllers/managerEnrollmentsController');
const { protect, requireManager } = require('../middleware/auth');
const {
  getManagerEnrollmentSchema,
  updateManagerEnrollmentSchema
} = require('../controllers/organizationEnrollmentController');

router.use(protect, requireManager);

router.get('/dashboard', getManagerDashboard);
router.get('/vehicles', getManagerVehicles);
router.get('/vehicles/live', getManagerFleetLive);
router.get('/routes', getManagerAssignableRoutes);
router.get('/requests', getMyRequests);
router.post('/vehicle-accounts', createManagerVehicle);
router.patch('/vehicle-accounts/:vehicleId/reset-password', resetVehicleAccountPassword);
router.get('/vehicles/:vehicleId', getManagerVehicleById);
router.put('/vehicles/:vehicleId', updateManagerVehicle);
router.post('/vehicles/:vehicleId/delete-request', requestVehicleDelete);


// Driver directory
router.get('/organizations', getOrganizationsForManager);
router.post('/organizations', createOrganizationForManager);
router.get('/organization/enrollment-schema', getManagerEnrollmentSchema);
router.put('/organization/enrollment-schema', updateManagerEnrollmentSchema);
router.get('/drivers', getManagerDrivers);
router.post('/drivers', createManagerDriver);
router.put('/drivers/:driverId', updateManagerDriver);
router.delete('/drivers/:driverId', deleteManagerDriver);
router.put('/drivers/:driverId/password', resetManagerDriverPassword);
// Returns the password in the clear to the owning manager, and audit-logs the
// read. Off unless DRIVER_PASSWORD_KEY is set — see utils/recoverablePassword.js.
router.get('/drivers/:driverId/password', getManagerDriverPassword);
router.get('/drivers/:driverId/enrollment-key', getDriverEnrollmentKey);
router.post('/drivers/:driverId/enrollment-key/rotate', rotateDriverEnrollmentKey);
router.post('/drivers/:driverId/enrollment-key/revert', revertDriverEnrollmentKey);

// Passengers redeeming a private driver's key land here for a decision.
// The count endpoint is declared first so it is not swallowed by /:id.
router.get('/enrollment-requests/count', getManagerEnrollmentRequestCount);
router.get('/enrollment-requests', getManagerEnrollmentRequests);
router.post('/enrollment-requests/:id/approve', approveManagerEnrollmentRequest);
router.post('/enrollment-requests/:id/reject', rejectManagerEnrollmentRequest);

// QR Attendance (see docs/features/qr-attendance/QR_SYSTEM.md)
router.get('/attendance', getManagerAttendance);
router.patch('/routes/:routeId/qr', updateRouteQr);

module.exports = router;
