const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { permissionGuard } = require('../middlewares/permissions');

router.get('/class/:classId', authenticateToken, permissionGuard({ allowedRoles: ['instructor', 'user', 'admin'], allowedStatus: ['approved'] }), chatController.getOrCreateClassChatRoom);
router.get('/rooms/:roomId', authenticateToken, permissionGuard({ allowedRoles: ['instructor','user','admin'], allowedStatus: ['approved'] }), chatController.getChatRoomDetail);
router.get('/rooms/:roomId/messages', authenticateToken, permissionGuard({ allowedRoles: ['instructor','user','admin'], allowedStatus: ['approved'] }), chatController.listChatMessages);
module.exports = router;