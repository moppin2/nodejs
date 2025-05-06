const express = require('express');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cors = require('cors');

require('dotenv').config();   // .gitignore 에 .env 반드시 추가해야함

const PORT = process.env.PORT;
const ACCESS_SECRET = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.REFRESH_TOKEN_SECRET;
const CLIENT_URL = process.env.CLIENT_URL;
const COOKIE_SECURE = process.env.COOKIE_SECURE;

const app = express();
app.use(cors({
  origin: CLIENT_URL, // 프론트엔드 주소
  credentials: true,  // 쿠키 보내기 허용
}));
app.use(express.json());
app.use(cookieParser());

// Middleware

const user = {
  email: 'moppin@naver.com',
  password: '2331', // 실제로는 bcrypt 등으로 해시해야 함
  username: '테스트'
};


// 단순 예제용 in-memory 저장소 (프로덕션에선 DB에 저장)
function signAccessToken(user) {
  return jwt.sign(
    { email: user.email, username: user.username },
    ACCESS_SECRET,
    { expiresIn: '5m' }
  );
}

function signRefreshToken(user) {
  return jwt.sign(
    { email: user.email, username: user.username },
    REFRESH_SECRET,
    { expiresIn: '7d' }
  );
}

// Login API
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  
  if (email === user.email && password === user.password) {
    
    const accessToken  = signAccessToken(user);
    const refreshToken = signRefreshToken(user);

    console.log(accessToken)
    console.log(refreshToken)

    // HttpOnly, Secure, SameSite 옵션을 실제 환경에 맞게 조정하세요.
    res
      .cookie('accessToken',  accessToken,  { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'Lax', maxAge: 5*60*1000 })
      .cookie('refreshToken', refreshToken, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'Lax', maxAge: 7*24*60*60*1000 })
      .json({ email: user.email, username: user.username });

  } else {
    console.log('로그인실패');
    res.status(401).json({ message: 'Invalid email or password' });
  }
});


//토큰 갱신
app.post('/refresh', (req, res) => {

  const token = req.cookies.refreshToken;
  if (!token) return res.sendStatus(401);

  jwt.verify(token, REFRESH_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);

    const newAccess  = signAccessToken(user);
    const newRefresh = signRefreshToken(user);

    res
      .cookie('accessToken',  newAccess,  { httpOnly: true, sameSite: 'Lax', maxAge: 5*60*1000 })
      .cookie('refreshToken', newRefresh, { httpOnly: true, sameSite: 'Lax', maxAge: 30*60*1000 })
      .sendStatus(200);
  });
});


// 인증 미들웨어
function authenticateToken(req, res, next) {
  const token = req.cookies.accessToken;

  if (!token) {
    console.log('[Auth] No access token in cookie');
    return res.sendStatus(401);
  }

  jwt.verify(token, ACCESS_SECRET, (err, user) => {
    if (err) {
      return res.sendStatus(403);
    }
    req.user = user;
    next();
  });
}

app.get('/me', authenticateToken, (req, res) => {  
  res.json(req.user); // req.user에는 id, username 등이 들어있음
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

app.post('/logout', (req, res) => {
  const token = req.cookies.refreshToken;

  res
    .clearCookie('accessToken')
    .clearCookie('refreshToken')
    .sendStatus(200);

});