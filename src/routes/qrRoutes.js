const express = require('express');
const router = express.Router();
const { issueQr, rotateQr } = require('../controllers/qrController');
const { protect } = require('../middleware/auth');

// All QR endpoints require an authenticated caller acting on their own account-scoped pass.
router.use(protect);

// POST /api/qr/issue - fresh QR token for the caller's account (reusable on every route)
router.post('/issue', issueQr);

// POST /api/qr/rotate - bump the caller's qrTokenVersion, revoking every prior QR pass
router.post('/rotate', rotateQr);

module.exports = router;
