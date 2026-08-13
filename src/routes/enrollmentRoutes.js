const express = require('express');
const router = express.Router();
const {
  redeemEnrollmentKey,
  resolveEnrollmentKey,
  enrollStudent,
  getMyEnrollments,
  leaveEnrollment
} = require('../controllers/enrollmentController');
const { protect, requireUser } = require('../middleware/auth');

// Passenger-facing. Managers manage enrollment requests through /api/manager.
router.use(protect, requireUser);

router.post('/redeem', redeemEnrollmentKey);
router.post('/resolve-key', resolveEnrollmentKey);
router.post('/students/:studentId', enrollStudent);
router.get('/mine', getMyEnrollments);
router.delete('/:id', leaveEnrollment);

module.exports = router;
