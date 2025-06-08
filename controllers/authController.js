const jwt = require('jsonwebtoken');
const { signAccessToken, signRefreshToken } = require('../utils/token'); // 가정: 이 유틸리티 함수들이 존재
const { REFRESH_SECRET, COOKIE_SECURE, ACCESS_SECRET } = require('../config'); // ACCESS_SECRET도 config에 있다고 가정
const bcrypt = require('bcrypt');
const { User, Instructor, Admin, RefreshToken, InstructorVerificationHistory, UploadFile } = require('../models');
const { Op } = require('sequelize');

// 내부 로그인 처리 함수 (회원가입 후에도 호출됨)
const handleLoginAndSetCookies = async (req, res, userInstance) => {
  const userPayloadForToken = {
    id: userInstance.id,
    userType: userInstance.userType,
    name: userInstance.name, // name을 페이로드에 포함
    email: userInstance.email,
    status: userInstance.status,
  };

  const accessToken = signAccessToken(userPayloadForToken);
  const refreshToken = signRefreshToken({ id: userInstance.id, userType: userInstance.userType });
  const socketToken = signAccessToken(userPayloadForToken); // Socket.IO용 토큰

  await RefreshToken.upsert({
    user_id: userInstance.id,
    user_type: userInstance.userType,
    token: refreshToken,
    user_agent: req.headers['user-agent'],
    ip_address: req.ip,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  });

  res
    .cookie('accessToken', accessToken, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'Lax', maxAge: 5 * 60 * 1000 })
    .cookie('refreshToken', refreshToken, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'Lax', maxAge: 7 * 24 * 60 * 60 * 1000 })
    .status(userInstance.isNewRecord ? 201 : 200)
    .json({
      id: userInstance.id,
      userType: userInstance.userType,
      username: userInstance.name, // 프론트에서 username으로 사용한다면 name을 username으로 매핑
      name: userInstance.name,     // name 필드도 명시적으로 전달
      email: userInstance.email,
      avatarUrl: userInstance.avatarUrl || null,
      status: userInstance.status,
      socketToken: socketToken,
      message: userInstance.isNewRecord ? '회원가입 및 로그인 성공' : '로그인 성공'
    });
};


exports.login = async (req, res) => {
  try {
    const { userType, email, password } = req.body;
    let userModel;
    switch (userType) {
      case 'user': userModel = User; break;
      case 'instructor': userModel = Instructor; break;
      case 'admin': userModel = Admin; break;
      default: return res.status(400).json({ message: '잘못된 사용자 유형입니다.' });
    }

    const user = await userModel.findOne({ where: { email } });
    if (!user) {
      return res.status(401).json({ message: '존재하지 않는 사용자이거나 이메일 또는 비밀번호가 잘못되었습니다.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.pwd_hash);
    if (!passwordMatch) {
      return res.status(401).json({ message: '존재하지 않는 사용자이거나 이메일 또는 비밀번호가 잘못되었습니다.' });
    }

    user.userType = userType; // 토큰 생성 및 응답에 필요

    const avatarFile = await UploadFile.findOne({
      where: { target_type: userType, target_id: user.id, purpose: 'profile', is_public: true }
    });
    const bucket = process.env.UPLOAD_BUCKET;
    user.avatarUrl = avatarFile?.file_key ? `https://${bucket}.s3.amazonaws.com/${avatarFile.file_key}` : null;

    user.isNewRecord = false;
    await handleLoginAndSetCookies(req, res, user);

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
};

exports.refresh = async (req, res) => {
  const incomingRefreshToken = req.cookies.refreshToken;
  if (!incomingRefreshToken) return res.status(401).json({ message: 'Refresh token이 제공되지 않았습니다.' });

  let payload;
  try {
    payload = jwt.verify(incomingRefreshToken, REFRESH_SECRET);
  } catch (err) {
    return res.status(403).json({ message: 'Refresh token이 유효하지 않습니다 (만료 또는 변조).' });
  }

  const { id, userType } = payload;

  const storedTokenRecord = await RefreshToken.findOne({
    where: { user_id: id, user_type: userType, token: incomingRefreshToken }
  });

  if (!storedTokenRecord) {
    return res.status(403).json({ message: '유효하지 않거나 탈취된 Refresh token 입니다.' });
  }
  if (new Date() > new Date(storedTokenRecord.expires_at)) {
    await storedTokenRecord.destroy();
    return res.status(403).json({ message: 'Refresh token이 만료되었습니다.' });
  }

  let userInstance; // 변수명 변경 (user -> userInstance)
  let userModel;
  switch (userType) {
    case 'user': userModel = User; break;
    case 'instructor': userModel = Instructor; break;
    case 'admin': userModel = Admin; break;
    default: return res.status(400).json({ message: '잘못된 사용자 유형입니다.' });
  }
  userInstance = await userModel.findByPk(id);

  if (!userInstance) {
    await storedTokenRecord.destroy();
    return res.status(404).json({ message: '사용자를 찾을 수 없습니다.' });
  }

  const avatarFile = await UploadFile.findOne({
    where: {
      target_type: userType,
      target_id: userInstance.id,
      purpose: 'profile',
      is_public: true,   // 필요 없으면 제거하세요
    }
  });

  const bucket = process.env.UPLOAD_BUCKET;
  userInstance.avatarUrl = avatarFile?.file_key ? `https://${bucket}.s3.amazonaws.com/${avatarFile.file_key}` : null;

  // Access Token 페이로드에 필요한 정보 구성
  const userPayloadForToken = {
    id: userInstance.id,
    userType,
    username: userInstance.name, // DB에서 가져온 최신 이름 사용
    email: userInstance.email, // DB에서 가져온 최신 이메일 사용
    avatarUrl: userInstance.avatarUrl,
    status: userInstance.status
  };
  const newAccessToken = signAccessToken(userPayloadForToken);
  const newRefreshToken = signRefreshToken({ id: userInstance.id, userType });

  await storedTokenRecord.destroy();
  await RefreshToken.create({
    user_id: userInstance.id,
    user_type: userType,
    token: newRefreshToken,
    user_agent: req.headers['user-agent'],
    ip_address: req.ip,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  });

  res
    .cookie('accessToken', newAccessToken, { path: '/', httpOnly: true, secure: COOKIE_SECURE, sameSite: 'Lax', maxAge: 5 * 60 * 1000 })
    .cookie('refreshToken', newRefreshToken, { path: '/', httpOnly: true, secure: COOKIE_SECURE, sameSite: 'Lax', maxAge: 7 * 24 * 60 * 60 * 1000 })
    .status(200)
    .json({
      message: 'Tokens refreshed successfully',
      accessToken: newAccessToken
    });
};

exports.logout = async (req, res) => {
  // ... (기존 로그아웃 로직)
  const token = req.cookies.refreshToken;
  if (token) {
    try {
      const payload = jwt.verify(token, REFRESH_SECRET);
      if (payload && payload.id && payload.userType) {
        await RefreshToken.destroy({
          where: { user_id: payload.id, user_type: payload.userType, token }
        });
      }
    } catch (err) {
      console.error('Logout: Error verifying refresh token:', err.message);
    }
  }
  res
    .clearCookie('accessToken', { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'Lax' })
    .clearCookie('refreshToken', { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'Lax' })
    .status(200)
    .json({ message: '성공적으로 로그아웃되었습니다.' });
};

exports.me = async (req, res) => {
  // authenticateToken 미들웨어에서 req.user를 설정한다고 가정
  // req.user는 Access Token 페이로드에서 온 정보 { id, userType, name, email, status }
  if (!req.user || !req.user.id || !req.user.userType) {
    return res.status(401).json({ message: '인증되지 않았거나 유효하지 않은 토큰입니다.' });
  }

  // Socket.IO 인증을 위한 새 토큰 생성 (Access Token과 동일한 정보로)
  // 이 토큰은 클라이언트 JavaScript가 접근 가능해야 함
  const socketToken = signAccessToken(req.user);

  res.json({
    // user 객체 형태로 한 번 더 감싸서 보낼 수도 있음: user: { ...userForResponse, socketToken }
    // 또는 바로 필요한 필드들을 보냄
    id: req.user.id,
    userType: req.user.userType,
    username: req.user.username,
    email: req.user.email,
    avatarUrl: req.user.avatarUrl,
    status: req.user.status,
    socketToken: socketToken // <<--- 소켓 인증용 토큰 추가
  });
};

exports.registerUser = async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;
    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(400).json({ message: '이미 등록된 이메일입니다.' });

    const pwd_hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, pwd_hash, name, phone_number: phone });

    user.userType = 'user';
    user.isNewRecord = true;
    user.avatarUrl = null;
    user.status = 'active';

    await handleLoginAndSetCookies(req, res, user);

  } catch (err) {
    console.error('User registration error:', err);
    res.status(500).json({ message: '서버 오류로 회원가입에 실패했습니다.' });
  }
};

exports.registerInstructor = async (req, res) => {
  try {
    const { email, password, name, phone, careerYears, majorCareer, introduction } = req.body;
    const existing = await Instructor.findOne({ where: { email } });
    if (existing) return res.status(400).json({ message: '이미 등록된 이메일입니다.' });

    const pwd_hash = await bcrypt.hash(password, 10);
    const instructor = await Instructor.create({
      email, pwd_hash, name, phone_number: phone,
      career_years: careerYears, main_experience: majorCareer,
      comment: introduction, joined_at: new Date().toISOString(),
      status: 'draft'
    });

    instructor.userType = 'instructor';
    instructor.isNewRecord = true;
    instructor.avatarUrl = null;

    await handleLoginAndSetCookies(req, res, instructor);

  } catch (err) {
    console.error('Instructor registration error:', err);
    res.status(500).json({ message: '서버 오류로 회원가입에 실패했습니다.' });
  }
};


resetInstructorVerificationFiles = async (instructor_id, file_keys = []) => {
  // 1. 기존 연결 해제
  await UploadFile.update(
    { target_id: null },
    {
      where: {
        target_type: 'instructor',
        target_id: instructor_id,
        purpose: 'verification'
      }
    }
  );

  // 2. 전달된 파일만 다시 연결
  if (file_keys.length > 0) {
    await UploadFile.update(
      { target_id: instructor_id },
      {
        where: {
          file_key: { [Op.in]: file_keys },
          target_type: 'instructor',
          purpose: 'verification'
        }
      }
    );
  }
};

exports.updateInstructorVerificationFiles = async (req, res) => {
  // if (!req.user || req.user.userType !== 'instructor') {
  //   return res.status(403).json({ message: '강사만 임시 저장이 가능합니다.' });
  // }

  const { instructor_id, file_keys = [] } = req.body;

  if (!instructor_id) {
    return res.status(400).json({ message: 'instructor_id는 필수입니다.' });
  }

  if (req.user.id !== instructor_id) {
    return res.status(403).json({ message: '본인의 파일만 임시 저장할 수 있습니다.' });
  }

  try {

    const instructor = await Instructor.findByPk(instructor_id);
    if (!instructor) return res.status(404).json({ message: '강사를 찾을 수 없습니다.' });

    // if (!['draft', 'rejected'].includes(instructor.status)) {
    //   return res.status(400).json({ message: '현재 상태에서는 임시 저장이 불가능합니다.' });
    // }

    await resetInstructorVerificationFiles(instructor_id, file_keys);
    res.status(200).json({ message: '파일 임시 저장이 완료되었습니다.' });
  } catch (err) {
    console.error('임시 저장 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

exports.submitInstructorVerification = async (req, res) => {
  // if (!req.user || req.user.userType !== 'instructor') {
  //   return res.status(403).json({ message: '강사만 제출할 수 있습니다.' });
  // }

  const { instructor_id, file_keys = [] } = req.body;

  if (!instructor_id) {
    return res.status(400).json({ message: 'instructor_id는 필수입니다.' });
  }

  if (req.user.id !== instructor_id) {
    return res.status(403).json({ message: '본인만 제출할 수 있습니다.' });
  }

  try {
    const instructor = await Instructor.findByPk(instructor_id);
    if (!instructor) return res.status(404).json({ message: '강사를 찾을 수 없습니다.' });

    // if (!['draft', 'rejected'].includes(instructor.status)) {
    //   return res.status(400).json({ message: '현재 상태에서는 제출이 불가능합니다.' });
    // }

    await resetInstructorVerificationFiles(instructor_id, file_keys);

    await instructor.update({ status: 'submitted' });

    await InstructorVerificationHistory.create({
      instructor_id,
      action: 'submitted',
      performed_by: req.user.id,
      performer_type: 'instructor',
      reason: null,
    });

    res.status(200).json({ message: '제출 완료' });
  } catch (err) {
    console.error('제출 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};


exports.getInstructorById = async (req, res) => {
  try {
    const instructor = await Instructor.findByPk(req.params.id);
    if (!instructor) {
      return res.status(404).json({ message: '강사를 찾을 수 없습니다.' });
    }
    res.json(instructor);
  } catch (err) {
    console.error('강사 조회 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

exports.getUserById = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ message: '사용자를 찾을 수 없습니다.' });
    }
    res.json(user);
  } catch (err) {
    console.error('사용자 조회 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

exports.updateInstructorStatus = async (req, res) => {
  try {
    const instructor = await Instructor.findByPk(req.params.id);
    if (!instructor) return res.status(404).json({ message: '강사를 찾을 수 없습니다.' });

    const { status, reason } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: '허용되지 않은 상태입니다.' });
    }

    if (instructor.status !== 'submitted') {
      return res.status(400).json({ message: '제출된 상태가 아니므로 승인 또는 반려할 수 없습니다.' });
    }

    await instructor.update({ status });

    await InstructorVerificationHistory.create({
      instructor_id: instructor.id,
      action: status,
      performed_by: req.user.id,
      performer_type: 'admin',
      reason: status === 'rejected' ? reason || null : null,
    });

    res.json({ message: '상태가 업데이트되었습니다.' });
  } catch (err) {
    console.error('강사 상태 변경 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};


exports.getInstructorVerificationHistory = async (req, res) => {
  const instructorId = req.params.id;

  try {
    const history = await InstructorVerificationHistory.findAll({
      where: { instructor_id: instructorId },
      order: [['created_at', 'DESC']],
    });

    res.status(200).json(history);
  } catch (err) {
    console.error('심사 이력 조회 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};