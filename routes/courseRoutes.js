const express = require('express');
const router = express.Router();
const courseController = require('../controllers/courseController');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { permissionGuard, checkCoursePermission } = require('../middlewares/permissions');

router.post('/api/course', authenticateToken, permissionGuard({ allowedRoles: ['instructor'], allowedStatus: ['approved'] }), courseController.upsertCourse);
router.get('/api/courses', courseController.getCourseList);
router.get('/api/course/:id', authenticateToken, checkCoursePermission, courseController.getCourseDetail); 
router.post('/api/enrollments/request', authenticateToken, courseController.applyToCourse); 

module.exports = router;
