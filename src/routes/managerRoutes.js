const express = require('express');
const router = express.Router();
const {
  createBusAccountRequest,
  getManagerBusById,
  getManagerBuses,
  getManagerBusLocation,
  getManagerDashboard,
  getMyRequests,
  requestBusDelete,
  resetBusAccountPassword,
  updateManagerBus
} = require('../controllers/managerController');
const { protect, requireManager } = require('../middleware/auth');

router.use(protect, requireManager);

router.get('/dashboard', getManagerDashboard);
router.get('/buses', getManagerBuses);
router.get('/requests', getMyRequests);
router.post('/bus-accounts', createBusAccountRequest);
router.patch('/bus-accounts/:busId/reset-password', resetBusAccountPassword);
router.get('/buses/:busId', getManagerBusById);
router.put('/buses/:busId', updateManagerBus);
router.post('/buses/:busId/delete-request', requestBusDelete);
router.get('/buses/:busId/location', getManagerBusLocation);

module.exports = router;
