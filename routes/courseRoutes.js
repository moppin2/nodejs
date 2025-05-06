const express = require('express');
const router = express.Router();
const courseController = require('../controllers/courseController');
const { authenticateToken } = require('../middlewares/authMiddleware');

router.post('/api/courses', authenticateToken, courseController.upsertCourse);
// router.post('/api/courses/:id', courseController.upsertCourse);
// router.get('/api/courses', courseController.listCourses);
// router.get('/api/courses/:id', courseController.getCourse);
// router.put('/api/courses/:id', courseController.updateCourse);

module.exports = router;
