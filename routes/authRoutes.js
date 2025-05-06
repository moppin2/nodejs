const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateToken } = require('../middlewares/authMiddleware');

router.post('/login', authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.get('/me', authenticateToken, authController.me); 
router.post('/api/register/user', authController.registerUser);
router.post('/api/register/instructor', authController.registerInstructor);

module.exports = router;
