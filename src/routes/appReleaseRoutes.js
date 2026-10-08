const express = require('express');
const router = express.Router();
const {
  listLatest,
  getLatestForTarget,
  listHistory,
  createRelease,
  updateReleaseStatus
} = require('../controllers/appReleaseController');
const { protect, requireSuperAdmin } = require('../middleware/auth');

// Public — mobile apps check for updates with no auth.
router.get('/', listLatest);
router.get('/latest', getLatestForTarget);

// Super-admin only — publishing/history management.
router.get('/history', protect, requireSuperAdmin, listHistory);
router.post('/', protect, requireSuperAdmin, createRelease);
router.patch('/:id', protect, requireSuperAdmin, updateReleaseStatus);

module.exports = router;
