const express = require('express');
const router = express.Router();
const {
  createManager,
  getManagers,
  getManagerById,
  updateManager,
  updateManagerStatus,
  deleteManager,
  resetManagerPassword,
  assignVehiclesToManager,
  getSuperAdminDashboard,
  getOperationsOverview,
  getManagerVehicleDetails,
  getPendingVehicleRequests,
  reviewVehicleRequest,
  getAuditLogs,
  getOrganizations,
  createOrganization
} = require('../controllers/superAdminController');
const {
  validateCreateManager,
  validateUpdateManager,
  validateManagerId,
  validateManagerStatus,
  validateManagerPasswordReset,
  validateAssignVehicles,
  validateCreateOrganization
} = require('../middleware/validators');
const { handleValidationErrors } = require('../middleware/errorHandler');
const { protect, requireSuperAdmin } = require('../middleware/auth');

router.use(protect, requireSuperAdmin);

router.get('/dashboard', getSuperAdminDashboard);
router.get('/operations', getOperationsOverview);
router.get('/operations/:managerId', validateManagerId, handleValidationErrors, getManagerVehicleDetails);
router.get('/vehicle-requests', getPendingVehicleRequests);
router.patch('/vehicle-requests/:requestId/review', reviewVehicleRequest);
router.get('/audit-logs', getAuditLogs);

router.get('/organizations', getOrganizations);
router.post('/organizations', validateCreateOrganization, handleValidationErrors, createOrganization);

router.post('/managers', validateCreateManager, handleValidationErrors, createManager);
router.get('/managers', getManagers);
router.get('/managers/:managerId', validateManagerId, handleValidationErrors, getManagerById);
router.put('/managers/:managerId', validateManagerId, validateUpdateManager, handleValidationErrors, updateManager);
router.patch('/managers/:managerId/status', validateManagerId, validateManagerStatus, handleValidationErrors, updateManagerStatus);
router.delete('/managers/:managerId', validateManagerId, handleValidationErrors, deleteManager);
router.patch('/managers/:managerId/reset-password', validateManagerId, validateManagerPasswordReset, handleValidationErrors, resetManagerPassword);
router.patch('/managers/:managerId/assign-vehicles', validateManagerId, validateAssignVehicles, handleValidationErrors, assignVehiclesToManager);

module.exports = router;
