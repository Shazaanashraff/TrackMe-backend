const express = require('express');
const router = express.Router();
const {
  redeemEnrollmentKey,
  getMyEnrollments,
  leaveEnrollment
} = require('../controllers/enrollmentController');
const { protect, requireUser } = require('../middleware/auth');

// Passenger-facing. Managers manage enrollment requests through /api/manager.
router.use(protect, requireUser);

router.post('/redeem', redeemEnrollmentKey);
router.get('/mine', getMyEnrollments);
router.delete('/:id', leaveEnrollment);

module.exports = router;
