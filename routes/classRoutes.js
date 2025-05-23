const express = require('express');
const router = express.Router();
const classController = require('../controllers/classController');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { permissionGuard, validateReservationTransition } = require('../middlewares/permissions');

router.post('/api/class', authenticateToken, permissionGuard({ allowedRoles: ['instructor'], allowedStatus: ['approved'] }), classController.upsertClass);
router.get('/api/myclasses', authenticateToken, classController.getMyClassList);
router.post('/api/class-reservations', authenticateToken, permissionGuard({ allowedRoles: ['user'] }), classController.createReservation);
router.patch('/api/class-reservations/:id/status', 
    authenticateToken, permissionGuard({ allowedRoles: ['user', 'instructor'], allowedStatus: ['approved'] }), validateReservationTransition, classController.changeReservationStatus);
module.exports = router;

