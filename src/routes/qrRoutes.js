const express = require('express');
const router = express.Router();
const { issueQr, rotateQr } = require('../controllers/qrController');
const { protect } = require('../middleware/auth');

// All QR endpoints require an authenticated caller (rider issuing/rotating their
// own QR, or a manager rotating a member's QR on their own route).
router.use(protect);

// POST /api/qr/issue - fresh token(s) for the caller's ACTIVE membership(s)
router.post('/issue', issueQr);

// POST /api/qr/rotate - bump tokenVersion, revoking prior QRs (self or, for a
// manager, a member on their own route)
router.post('/rotate', rotateQr);

module.exports = router;
