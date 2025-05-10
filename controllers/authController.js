const jwt = require('jsonwebtoken');
const { signAccessToken, signRefreshToken } = require('../utils/token');
const { REFRESH_SECRET, COOKIE_SECURE } = require('../config');

const bcrypt = require('bcrypt');
const { User, Instructor, RefreshToken } = require('../models');

exports.login = async (req, res) => {
  try {
    const { userType, email, password } = req.body;

    let user = null;

    if (userType === 'user') {
      user = await User.findOne({ where: { email } });
    } else if (userType === 'instructor') {
      user = await Instructor.findOne({ where: { email } });
    } else {
      return res.status(400).json({ message: '잘못된 사용자 유형입니다.' });
    }

    if (!user) {
      return res.status(401).json({ message: '존재하지 않는 사용자입니다.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.pwd_hash);

    if (!passwordMatch) {
      return res.status(401).json({ message: '비밀번호가 일치하지 않습니다.' });
    }

    user.userType = userType;

    const accessToken = signAccessToken(user);      // 토큰 생성 시 userType도 포함되게 하면 좋음
    const refreshToken = signRefreshToken(user);

    await RefreshToken.upsert({
      user_id: user.id,
      user_type: userType,
      token: refreshToken,
      user_agent: req.headers['user-agent'],
      ip_address: req.ip,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7일 후
    });

    res
      .cookie('accessToken', accessToken, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'Lax', maxAge: 5 * 60 * 1000 })
      .cookie('refreshToken', refreshToken, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'Lax', maxAge: 7 * 24 * 60 * 60 * 1000 })
      .json({ userType, id: user.id, email: user.email, username: user.name }); 

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
};

exports.refresh = async (req, res) => {
  const token = req.cookies.refreshToken;
  if (!token) return res.status(401).json({ message: 'Refresh token 없음' });

  let payload;
  try {
    payload = jwt.verify(token, REFRESH_SECRET);
  } catch (err) {
    return res.status(403).json({ message: 'Refresh token 유효하지 않음' });
  }

  const { id, userType } = payload;

  // 1. DB에 저장된 토큰 확인
  const storedToken = await RefreshToken.findOne({
    where: { user_id: id, user_type: userType, token }
  });

  if (!storedToken) return res.status(403).json({ message: 'DB에 저장된 토큰이 아님' });
  if (new Date() > storedToken.expires_at) return res.status(403).json({ message: '토큰 만료됨' });

  // 2. 사용자 정보 조회 (access token용 payload 복원)
  let user;
  if (userType === 'user') {
    user = await User.findByPk(id);
  } else if (userType === 'instructor') {
    user = await Instructor.findByPk(id);
  }

  if (!user) return res.status(404).json({ message: '사용자 없음' });

  // 3. 새 토큰 발급
  const newAccess = signAccessToken({
    id: user.id,
    userType,
    username: user.name,
    email: user.email
  });

  const newRefresh = signRefreshToken({ id: user.id, userType });

  // 4. DB 갱신
  await RefreshToken.upsert({
    user_id: user.id,
    user_type: userType,
    token: newRefresh,
    user_agent: req.headers['user-agent'],
    ip_address: req.ip,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  });

  // 5. 클라이언트에 토큰 전달
  res
    .cookie('accessToken', newAccess, { httpOnly: true, sameSite: 'Lax', maxAge: 5 * 60 * 1000 })
    .cookie('refreshToken', newRefresh, { httpOnly: true, sameSite: 'Lax', maxAge: 7 * 24 * 60 * 60 * 1000 })
    .sendStatus(200);
};

exports.logout = async (req, res) => {
  
  const token = req.cookies.refreshToken;
  if (!token) {
    return res
      .clearCookie('accessToken')
      .clearCookie('refreshToken')
      .sendStatus(200); // 쿠키만 지우고 끝
  }

  try {
    const payload = jwt.verify(token, REFRESH_SECRET);
    const { id, userType } = payload;

    // DB에서 refresh token 삭제
    await RefreshToken.destroy({
      where: {
        user_id: id,
        user_type: userType,
        token
      }
    });
  } catch (err) {
    // 유효하지 않은 토큰이더라도 쿠키는 삭제
    console.error('logout error:', err.message);
  }

  // 쿠키 삭제
  res
    .clearCookie('accessToken')
    .clearCookie('refreshToken')
    .sendStatus(200);
};

exports.me = (req, res) => {
  res.json(req.user);
};

exports.registerUser = async (req, res) => {  
  try {
    const { email, password, name, phone } = req.body;
    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(400).json({ message: '이미 등록된 이메일입니다.' });

    const pwd_hash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, pwd_hash, name, phone_number: phone });
  
    user.userType = 'user'; // ✅ 토큰 발급용
    await login(req, res, user); // ✅ 로그인 처리

    // return res.status(201).json({ message: '회원가입 성공', userId: user.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류' });
  }

};

exports.registerInstructor = async (req, res) => {
  try {
    const { email, password, name, phone, careerYears, majorCareer, introduction } = req.body;
    const existing = await Instructor.findOne({ where: { email } });
    if (existing) return res.status(400).json({ message: '이미 등록된 이메일입니다.' });

    const pwd_hash = await bcrypt.hash(password, 10);
    const instructor = await Instructor.create({
      email,
      pwd_hash,
      name,
      phone_number: phone,
      career_years: careerYears,
      main_experience: majorCareer,
      comment: introduction,
      joined_at: new Date().toISOString()
    });
    
    instructor.userType = 'instructor'; // ✅ 토큰 발급용
    await login(req, res, instructor); // ✅ 로그인 처리

    // return res.status(201).json({ message: '강사회원 가입 성공', instructorId: instructor.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류' });
  }
};

const login = async (req, res, user) => {
  // const userType = user.userType; // ✅ 직접 추출

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  await RefreshToken.upsert({
    user_id: user.id,
    user_type: user.userType,
    token: refreshToken,
    user_agent: req.headers['user-agent'],
    ip_address: req.ip,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7일
  });

  res
    .cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: 'Lax',
      maxAge: 5 * 60 * 1000
    })
    .cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: 'Lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    })
    .status(201)
    .json({
      message: '회원가입 및 로그인 성공',
      userType: user.userType,
      email: user.email,
      username: user.name
    });
};

