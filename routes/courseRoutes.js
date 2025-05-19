const express = require('express');
const router = express.Router();
const courseController = require('../controllers/courseController');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { permissionGuard, checkCoursePermission } = require('../middlewares/permissions');

router.post('/api/course', authenticateToken, permissionGuard({ allowedRoles: ['instructor'], allowedStatus: ['approved'] }), courseController.upsertCourse);
router.get('/api/courses', courseController.getCourseList);
router.get('/api/course/:id', authenticateToken, checkCoursePermission, courseController.getCourseDetail); 
router.post('/api/enrollments/request', authenticateToken, permissionGuard({ allowedRoles: ['user'] }), courseController.applyToCourse); 
router.post('/api/enrollments/approve', authenticateToken, permissionGuard({ allowedRoles: ['instructor'] }), courseController.approveCourseApplications); 
router.post('/api/enrollments/reject', authenticateToken, permissionGuard({ allowedRoles: ['instructor'] }), courseController.rejectCourseApplications ); 
router.get('/api/enrollments/pending-by-instructor/:courseId?', authenticateToken, permissionGuard({ allowedRoles: ['instructor'] }), courseController.getPendingEnrollmentsByInstructor); 
module.exports = router;
