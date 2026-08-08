const express = require('express');
const router = express.Router();
const { getMyEnrollmentKey } = require('../controllers/driverAccountController');
const { protect, requireDriver } = require('../middleware/auth');

router.use(protect, requireDriver);

// GET /api/driver/enrollment-key - the signed-in driver's own key
router.get('/enrollment-key', getMyEnrollmentKey);

module.exports = router;
