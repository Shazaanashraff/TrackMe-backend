const express = require('express');
const router = express.Router();
const { getRiderAttendance, getStudentAttendance } = require('../controllers/attendanceController');
const { protect } = require('../middleware/auth');

router.use(protect);

// GET /api/attendance/student/:studentId - events + summary (self or manager)
router.get('/rider/:riderId', getRiderAttendance);
// Compatibility for clients released before rider-neutral terminology.
router.get('/student/:studentId', getStudentAttendance);

module.exports = router;
