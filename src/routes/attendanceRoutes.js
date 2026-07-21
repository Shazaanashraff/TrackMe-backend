const express = require('express');
const router = express.Router();
const { getStudentAttendance } = require('../controllers/attendanceController');
const { protect } = require('../middleware/auth');

router.use(protect);

// GET /api/attendance/student/:studentId - events + summary (self or manager)
router.get('/student/:studentId', getStudentAttendance);

module.exports = router;
