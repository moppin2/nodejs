const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const { UploadFile } = require('../models');
require('dotenv').config();

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const generatePresignedUploadUrl = async (req, res) => {
  try {
    let { target_type, purpose, file_type, extension, is_public } = req.body;

    if (!target_type || !purpose || !file_type || !extension) {
      return res.status(400).json({ error: '필수 항목이 누락되었습니다.' });
    }

    // 간단한 입력값 필터링 (보안 강화)
    const sanitize = str => str.replace(/[^a-zA-Z0-9_-]/g, '');
    target_type = sanitize(target_type);
    purpose = sanitize(purpose);

    const fileId = uuidv4();
    const fileName = `${fileId}.${extension}`;
    const fileKey = is_public
      ? `public/${target_type}/${purpose}/${fileName}`
      : `uploads/${target_type}/${purpose}/${fileName}`;

    const command = new PutObjectCommand({
      Bucket: process.env.UPLOAD_BUCKET,
      Key: fileKey,
      ContentType: file_type,
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 });

    return res.status(200).json({
      presigned_url: signedUrl,
      file_key: fileKey,
      file_name: fileName,
    });
  } catch (err) {
    console.error('Presigned URL 생성 오류:', err);
    return res.status(500).json({ error: 'Presigned URL 생성에 실패했습니다.' });
  }
};


const recordUpload = async (req, res) => {
  try {
    const { target_type, target_id, purpose, file_key, file_name, file_type, size, is_public } = req.body;
    const user_id = req.user?.id || null; // 비로그인 업로드도 허용할 경우 대비

    if (!file_key || !file_name) {
      return res.status(400).json({ message: '필수 값 누락' });
    }

    const record = await UploadFile.create({
      user_id,
      target_type,
      target_id,
      purpose,
      file_key,
      file_name,
      file_type,
      size,
      is_public
    });

    res.status(201).json({ message: '파일 정보 저장 완료', id: record.id });
  } catch (err) {
    console.error('업로드 기록 저장 오류:', err);
    res.status(500).json({ message: 'DB 저장 실패' });
  }
};

const getUploadList = async (req, res) => {
  try {
    const { target_type, target_id, purpose } = req.query;

    if (!target_type || !target_id || !purpose) {
      return res.status(400).json({ message: '필수 쿼리 누락' });
    }

    // if (req.user.userType === 'user') {
    //   return res.status(400).json({ message: '알반회원은 권한이 없습니다.' });
    // }

    if (req.user.userType === 'instructor' && req.user.id != Number(target_id)) {
      return res.status(400).json({ message: '본인 자료만 조회 가능합니다.' });
    }

    const list = await UploadFile.findAll({
      where: { target_type, target_id, purpose },
      order: [['created_at', 'DESC']]
    });

    res.status(200).json(list);
  } catch (err) {
    console.error('파일 목록 조회 오류:', err);
    res.status(500).json({ message: '목록 조회 실패' });
  }
};

const generateDownloadUrl = async (req, res) => {
  try {
    const { file_key } = req.query;

    if (!file_key) {
      return res.status(400).json({ message: 'file_key는 필수입니다.' });
    }

    const command = new GetObjectCommand({
      Bucket: process.env.UPLOAD_BUCKET,
      Key: file_key,
    });

    const url = await getSignedUrl(s3, command, { expiresIn: 60 }); // 60초 유효

    return res.status(200).json({ url });
  } catch (err) {
    console.error('Presigned 다운로드 URL 생성 오류:', err);
    return res.status(500).json({ message: 'Presigned URL 생성 실패' });
  }
};

module.exports = { generatePresignedUploadUrl, recordUpload, getUploadList, generateDownloadUrl };
