const express = require('express');
const router = express.Router();
const fileController = require('../controllers/fileController');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { permissionGuard, checkUploadPermission } = require('../middlewares/permissions');

router.post('/api/upload', authenticateToken, checkUploadPermission, fileController.generatePresignedUploadUrl);
router.post('/api/upload/guest', fileController.generatePresignedUploadUrl);
router.post('/api/upload/record', authenticateToken, fileController.recordUpload);
router.get('/api/download/presigned-url', authenticateToken, fileController.generateDownloadPresignedUrl);
router.get('/api/public/file-urls', fileController.getPublicFileUrl);

module.exports = router;
