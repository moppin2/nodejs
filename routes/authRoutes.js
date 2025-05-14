const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { permissionGuard } = require('../middlewares/permissions');

router.post('/login', authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authenticateToken, authController.logout);
router.get('/me', authenticateToken, authController.me); 
router.post('/api/register/user', authController.registerUser);
router.post('/api/register/instructor', authController.registerInstructor);
router.post('/api/instructor/verify/temp-save', authenticateToken, permissionGuard({ allowedRoles: ['instructor'], allowedStatus: ['draft', 'rejected'] }), authController.updateInstructorVerificationFiles);
router.post('/api/instructor/verify/submit', authenticateToken, permissionGuard({ allowedRoles: ['instructor'], allowedStatus: ['draft', 'rejected'] }), authController.submitInstructorVerification);
router.get('/api/instructor/:id', authenticateToken, authController.getInstructorById);
router.patch('/api/instructor/:id/status', authenticateToken, permissionGuard({ allowedRoles: ['admin']}), authController.updateInstructorStatus);
router.get('/api/instructor/:id/history', authenticateToken, permissionGuard({ allowedRoles: ['admin', 'instructor']}), authController.getInstructorVerificationHistory);

module.exports = router;
