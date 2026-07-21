const express = require('express');
const router = express.Router();
const { scanBoarding, getBoardingRoster } = require('../controllers/boardingController');
const { protect, requireDriver } = require('../middleware/auth');

router.use(protect, requireDriver);

// POST /api/driver/boarding/scan - verify a rider's QR and record BOARD/ALIGHT
router.post('/scan', scanBoarding);

// GET /api/driver/boarding/roster - enrolled roster + current on-board count for the driver's bus
router.get('/roster', getBoardingRoster);

module.exports = router;
