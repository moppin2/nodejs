const express = require('express');
const router = express.Router();
const courseController = require('../controllers/courseController');
const { authenticateToken } = require('../middlewares/authMiddleware');

router.post('/api/course', authenticateToken, courseController.upsertCourse);
router.get('/api/courses', courseController.getCourseList);
router.get('/api/course/:id', courseController.getCourseDetail); 

module.exports = router;
