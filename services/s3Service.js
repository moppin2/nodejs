const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// S3 클라이언트 초기화 (애플리케이션 실행 시 한 번만 수행되도록)
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

const UPLOAD_BUCKET = process.env.UPLOAD_BUCKET; // .env 파일 등에서 S3 버킷 이름 가져오기

/**
 * S3 객체에 대한 Pre-signed GET URL (다운로드/조회용)을 생성합니다.
 * @param {string} fileKey - S3 객체 키 (파일 경로 및 이름)
 * @param {number} expiresInSeconds - URL 유효 시간 (초 단위, 기본값: 1시간)
 * @returns {Promise<string>} Pre-signed URL
 */
async function generatePresignedGetUrl(fileKey, expiresInSeconds = 60) {
    if (!fileKey) {
        throw new Error('fileKey is required to generate a pre-signed GET URL.');
    }
    try {
        const command = new GetObjectCommand({
            Bucket: UPLOAD_BUCKET,
            Key: fileKey,
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
        return url;
    } catch (error) {
        console.error(`S3 Service: Error generating pre-signed GET URL for key "${fileKey}":`, error);
        // 실제 운영 환경에서는 에러를 좀 더 구조화하거나, null을 반환하는 등의 처리가 필요할 수 있습니다.
        throw new Error('Failed to generate pre-signed GET URL.');
    }
}

/**
 * S3 객체에 대한 Pre-signed PUT URL (업로드용)을 생성합니다.
 * @param {string} fileKey - S3 객체 키 (업로드될 파일 경로 및 이름)
 * @param {string} contentType - 업로드될 파일의 Content-Type
 * @param {number} expiresInSeconds - URL 유효 시간 (초 단위, 기본값: 5분)
 * @returns {Promise<string>} Pre-signed URL
 */
async function generatePresignedPutUrl(fileKey, contentType, expiresInSeconds = 300) {
    if (!fileKey || !contentType) {
        throw new Error('fileKey and contentType are required to generate a pre-signed PUT URL.');
    }
    try {
        const command = new PutObjectCommand({
            Bucket: UPLOAD_BUCKET,
            Key: fileKey,
            ContentType: contentType,
            // ACL: 'private', // 필요하다면 ACL 설정 (버킷 기본값 사용 가능)
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
        return url;
    } catch (error) {
        console.error(`S3 Service: Error generating pre-signed PUT URL for key "${fileKey}":`, error);
        throw new Error('Failed to generate pre-signed PUT URL.');
    }
}

// TODO: 필요하다면 파일 삭제 함수 등도 추가할 수 있습니다.
// async function deleteS3Object(fileKey) { ... }

module.exports = {
    generatePresignedGetUrl,
    generatePresignedPutUrl,
    // deleteS3Object,
};