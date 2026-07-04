const express = require('express');
const router = express.Router();
const {
  recordRoute,
  getMyCustomRoute,
  reportJourney,
  recordRouteUpdate
} = require('../controllers/customRouteController');
const { protect, requireDriver } = require('../middleware/auth');

router.use(protect, requireDriver);

router.get('/my-route', getMyCustomRoute);
router.post('/record', recordRoute);
router.post('/:routeId/report-journey', reportJourney);
router.post('/:routeId/record-update', recordRouteUpdate);

module.exports = router;
