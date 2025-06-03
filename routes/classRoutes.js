const express = require('express');
const router = express.Router();
const classController = require('../controllers/classController');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { permissionGuard, validateReservationTransition } = require('../middlewares/permissions');

router.post('/api/class', authenticateToken, permissionGuard({ allowedRoles: ['instructor'], allowedStatus: ['approved'] }), classController.upsertClass);
router.get('/api/class/:classId', authenticateToken, permissionGuard({ allowedRoles: ['instructor', 'user'], allowedStatus: ['approved'] }), classController.getClassById);
router.get('/api/myclasses/:classId?', authenticateToken, classController.getMyClassList);
router.post('/api/class-reservations', authenticateToken, permissionGuard({ allowedRoles: ['user'] }), classController.createReservation);
router.patch('/api/class-reservations/:id/status',
    authenticateToken, permissionGuard({ allowedRoles: ['user', 'instructor'], allowedStatus: ['approved'] }), validateReservationTransition, classController.changeReservationStatus);
router.post('/api/class-feedbacks', authenticateToken, permissionGuard({ allowedRoles: ['instructor'], allowedStatus: ['approved'] }), classController.createFeedback);
router.put('/api/class-feedbacks/:feedbackId', authenticateToken, permissionGuard({ allowedRoles: ['instructor'], allowedStatus: ['approved'] }), classController.updateFeedback);
router.get('/api/class-feedbacks/:feedbackId', authenticateToken, permissionGuard({ allowedRoles: ['instructor', 'user'], allowedStatus: ['approved'] }), classController.getFeedbackDetails);
router.put('/api/class-feedbacks/:feedbackId/request-publication', authenticateToken, permissionGuard({ allowedRoles: ['instructor'], allowedStatus: ['approved'] }), classController.requestFeedbackPublication);
router.put('/api/class-feedbacks/:feedbackId/finalize-non-public', authenticateToken, permissionGuard({ allowedRoles: ['instructor'], allowedStatus: ['approved'] }), classController.finalizeFeedbackAsNonPublic);
router.put('/api/class-feedbacks/:feedbackId/approve-publication', authenticateToken, permissionGuard({ allowedRoles: ['user'] }), classController.approveFeedbackPublication);
router.put('/api/class-feedbacks/:feedbackId/reject-publication', authenticateToken, permissionGuard({ allowedRoles: ['user'] }), classController.rejectFeedbackPublication);
router.get('/api/course-progress', classController.getCourseProgressWithStatus);
router.get('/api/classes/:classId/my-review', authenticateToken, permissionGuard({ allowedRoles: ['user'] }), classController.getMyReviewForClass);
router.post('/api/class-reviews', authenticateToken, permissionGuard({ allowedRoles: ['user'] }), classController.createClassReview);
router.get('/api/class-detail/:classId', classController.getClassDetail);
module.exports = router;