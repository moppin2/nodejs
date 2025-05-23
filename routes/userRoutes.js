const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

router.get('/api/profile/:type/:id', userController.getProfile);
module.exports = router;