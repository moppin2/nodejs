const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const AWS = require('aws-sdk');
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

    const s3 = new AWS.S3(); // AWS SDK S3 인스턴스
    let display_url;

    if (is_public) { // is_public은 req.body 또는 저장된 UploadFile 레코드에서 가져옴
      const bucketName = process.env.UPLOAD_BUCKET;; // .env 등에서 버킷 이름 가져오기
      display_url = `https://${bucketName}.s3.amazonaws.com/${file_key}`;
    } else {
      const params = {
        Bucket: process.env.UPLOAD_BUCKET,
        Key: file_key,
        Expires: 60 * 15 // 예: 15분 동안 유효한 URL
      };
      try {
        display_url = await s3.getSignedUrlPromise('getObject', params);
      } catch (s3Error) {
        console.error("Error generating presigned URL for private file:", s3Error);
        // 적절한 에러 처리
      }
    }
    // 응답에 display_url 포함
    res.status(200).json({
      message: '파일 기록 성공',
      file_key,
      url: display_url, // 또는 display_url 이라는 명확한 필드명 사용
    });

  } catch (err) {
    console.error('업로드 기록 저장 오류:', err);
    res.status(500).json({ message: 'DB 저장 실패' });
  }
};

const getVerifyFileList = async (req, res) => {
  try {
    const { target_type, target_id, purpose } = req.query;

    if (!target_type || !target_id || !purpose) {
      return res.status(400).json({ message: '필수 쿼리 누락' });
    }

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

const generateDownloadPresignedUrl = async (req, res) => {
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

const getPublicFileUrl = async (req, res) => {
  try {
    const { target_type, target_id, purpose } = req.query;

    if (!target_type || !target_id || !purpose) {
      return res.status(400).json({ message: '필수 쿼리 누락' });
    }

    // 1) DB에서 공개된 파일만 조회
    const files = await UploadFile.findAll({
      where: {
        target_type,
        target_id,
        purpose,
        is_public: true
      },
      order: [['created_at', 'DESC']]
    });

    // 2) S3 버킷 네임 가져오기
    const bucket = process.env.UPLOAD_BUCKET;

    // 3) file_key → 퍼블릭 URL 변환
    const urls = files.map(f => ({
      id: f.id,
      file_key: f.file_key,
      url: `https://${bucket}.s3.amazonaws.com/${f.file_key}`,
      created_at: f.created_at
    }));

    // 4) URL 리스트 리턴
    return res.status(200).json(urls);
  } catch (err) {
    console.error('파일 목록 조회 오류:', err);
    return res.status(500).json({ message: '목록 조회 실패' });
  }
};

module.exports = { generatePresignedUploadUrl, recordUpload, getVerifyFileList, generateDownloadPresignedUrl, getPublicFileUrl };
