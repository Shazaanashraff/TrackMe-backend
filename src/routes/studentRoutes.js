const express = require('express');
const { protect, requireUser } = require('../middleware/auth');
const { listStudents, createStudent, updateStudent, archiveStudent } = require('../controllers/studentController');

const router = express.Router();
router.use(protect, requireUser);
router.get('/', listStudents);
router.post('/', createStudent);
router.patch('/:studentId', updateStudent);
router.delete('/:studentId', archiveStudent);

module.exports = router;
