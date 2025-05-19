const express = require('express');
const router = express.Router();
const classController = require('../controllers/classController');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { permissionGuard } = require('../middlewares/permissions');

router.post('/api/class', authenticateToken, permissionGuard({ allowedRoles: ['instructor'], allowedStatus: ['approved'] }), classController.upsertClass);
router.get('/api/classes', classController.getClassList);
module.exports = router;