const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const fileController = require('../controllers/fileController');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { permissionGuard } = require('../middlewares/permissions');

router.post('/api/register/user', authController.registerUser);
router.post('/api/register/instructor', authController.registerInstructor);

//강사 인증관련
router.post('/api/instructor/verify/temp-save', authenticateToken, permissionGuard({ allowedRoles: ['instructor'], allowedStatus: ['draft', 'rejected'] }), authController.updateInstructorVerificationFiles);
router.post('/api/instructor/verify/submit', authenticateToken, permissionGuard({ allowedRoles: ['instructor'], allowedStatus: ['draft', 'rejected'] }), authController.submitInstructorVerification);
router.get('/api/instructor/:id', authenticateToken, authController.getInstructorById);
router.get('/api/user/:id', authenticateToken, authController.getUserById);
router.patch('/api/instructor/:id/status', authenticateToken, permissionGuard({ allowedRoles: ['admin']}), authController.updateInstructorStatus);
router.get('/api/instructor/:id/history', authenticateToken, permissionGuard({ allowedRoles: ['admin', 'instructor']}), authController.getInstructorVerificationHistory);
router.get('/api/verifyfile/list', authenticateToken, permissionGuard({ allowedRoles: ['instructor', 'admin'] }), fileController.getVerifyFileList);

module.exports = router;
