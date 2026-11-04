const express = require('express');
const router = express.Router();
const { getCurrent, submitRun, discardRun } = require('../controllers/customRouteController');
const { protect, requireDriver } = require('../middleware/auth');

// Driver-side custom route recording. Mounted at /api/driver/custom-routes.
router.use(protect, requireDriver);

router.get('/current', getCurrent);
router.post('/runs', submitRun);
router.delete('/runs/:runId', discardRun);

module.exports = router;
