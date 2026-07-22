const express = require('express');
const router = express.Router();
const { scanBoarding } = require('../controllers/boardingController');
const { protect, requireDriver } = require('../middleware/auth');

router.use(protect, requireDriver);

// POST /api/driver/boarding/scan - verify a rider's QR and record BOARD/ALIGHT
router.post('/scan', scanBoarding);

module.exports = router;
