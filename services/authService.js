// src/services/authService.js (또는 utils/authUtils.js 등 실제 경로)

const jwt = require('jsonwebtoken');
const { User, Instructor, Admin } = require('../models'); // 실제 모델 경로로 수정
const { ACCESS_SECRET } = require('../config'); // Access Token 검증용 시크릿 키 (config.js 등에서 가져옴)

/**
 * 제공된 Access Token을 검증하고, 유효한 경우 해당 사용자 정보를 DB에서 조회하여 반환합니다.
 * Socket.IO 인증 미들웨어에서 사용됩니다.
 * @param {string} accessToken - 검증할 Access Token 문자열
 * @returns {Promise<object|null>} 성공 시 사용자 정보 객체 (id, userType, name, status 등 포함), 실패 시 에러 throw
 */
async function verifyTokenAndGetUser(accessToken) {
    if (!accessToken) {
        throw new Error('인증 토큰(Access Token)이 제공되지 않았습니다.');
    }

    try {
        // 1. Access Token 검증 및 페이로드 디코딩
        // ACCESS_SECRET은 Access Token 서명 시 사용된 비밀키여야 합니다.
        const decoded = jwt.verify(accessToken, ACCESS_SECRET);

        if (!decoded || !decoded.id || !decoded.userType) {
            throw new Error('토큰 페이로드에 필수 사용자 정보(id, userType)가 없습니다.');
        }

        // 2. 디코딩된 정보를 바탕으로 실제 사용자 정보 조회 (DB에서 최신 정보 확인)
        let userRecord = null;
        const userId = decoded.id;
        const userTypeFromToken = decoded.userType;

        switch (userTypeFromToken) {
            case 'user':
                userRecord = await User.findByPk(userId, {
                    attributes: ['id', 'name', 'email'], // 필요한 필드 선택
                });
                break;
            case 'instructor':
                userRecord = await Instructor.findByPk(userId, {
                    attributes: ['id', 'name', 'email', 'status'], // 강사의 경우 'status'도 중요
                });
                break;
            case 'admin':
                userRecord = await Admin.findByPk(userId, {
                    attributes: ['id', 'name', 'email', 'role'],
                });
                break;
            default:
                throw new Error(`알 수 없는 사용자 유형입니다: ${userTypeFromToken}`);
        }

        if (!userRecord) {
            throw new Error(`사용자 (ID: ${userId}, Type: ${userTypeFromToken})를 찾을 수 없습니다.`);
        }
        
        // 반환할 객체에 userType을 명시적으로 포함 (모델에 userType 필드가 없더라도)
        const userData = userRecord.get({ plain: true });
        userData.userType = userTypeFromToken; // 토큰에서 가져온 userType 사용

        // 강사의 경우, 'approved' 상태가 아니면 Socket.IO 연결을 제한할 수도 있습니다 (정책에 따라).
        // 예: if (userData.userType === 'instructor' && userData.status !== 'approved') {
        //     throw new Error('승인된 강사만 실시간 기능을 사용할 수 있습니다.');
        // }

        return userData; // { id, userType, name, email, status?, role? } 형태의 객체

    } catch (error) {
        // jwt.verify에서 발생하는 에러 (JsonWebTokenError, TokenExpiredError 등)
        if (error.name === 'TokenExpiredError') {
            throw new Error('Authentication error: 인증 토큰(Access Token)이 만료되었습니다.');
        } else if (error.name === 'JsonWebTokenError') {
            throw new Error('Authentication error: 인증 토큰(Access Token)이 유효하지 않습니다.');
        }
        // 그 외 DB 조회 오류 등
        console.error('AuthService (verifyAccessTokenAndGetUser) Error:', error.message);
        throw new Error(error.message || '토큰 검증 또는 사용자 조회 중 오류가 발생했습니다.');
    }
}

// generateToken 함수는 authController.js 내의 signAccessToken, signRefreshToken을 그대로 사용하거나,
// 필요하다면 이 서비스로 옮겨올 수도 있습니다. 현재는 verify 함수만 여기에 둡니다.

module.exports = {
    verifyTokenAndGetUser,
    // 만약 토큰 생성 로직도 여기로 옮긴다면:
    // generateAccessToken: (user) => signAccessToken(user), // signAccessToken을 여기서 직접 구현하거나 import
    // generateRefreshToken: (user) => signRefreshToken(user),
};
