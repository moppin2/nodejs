const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/authMiddleware'); 
const fcmTokenController = require('../controllers/fcmTokenController');

router.post('/register', authenticateToken, fcmTokenController.registerToken);
router.post('/remove', authenticateToken, fcmTokenController.removeToken);

module.exports = router;
