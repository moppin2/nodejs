const express = require('express');
const router = express.Router();
const uploadController = require('../controllers/uploadController');
const { authenticateToken } = require('../middlewares/authMiddleware');

router.post('/api/upload', authenticateToken, uploadController.generatePresignedUploadUrl);
router.post('/api/upload/guest', uploadController.generatePresignedUploadUrl);
router.post('/api/upload/record', authenticateToken, uploadController.recordUpload);
router.get('/api/upload/list', authenticateToken, uploadController.getUploadList);
router.get('/api/upload/download-url', authenticateToken, uploadController.generateDownloadUrl);

module.exports = router;
