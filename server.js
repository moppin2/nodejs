const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { PORT, CLIENT_URL } = require('./config');

const db = require('./models')

const authRoutes = require('./routes/authRoutes');
const courseRoutes = require('./routes/courseRoutes');
const classRoutes = require('./routes/classRoutes');
const codeRoutes = require('./routes/codeRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const licenseRoutes = require('./routes/licenseRoutes');

const app = express();

// app.use(cors({
//   origin: CLIENT_URL,
//   credentials: true
// }));

// ① 허용할 Origin 목록 (개발 중이라면 * 도 무방)
const whitelist = [
  'http://localhost:3000',
  'http://192.168.0.85:3000'   // ← 모바일에서 접속하는 IP:포트
];

// ② CORS 옵션
const corsOptions = {
  origin(origin, callback) {
    // origin이 없으면 curl/postman 등 서버→서버 호출이므로 허용
    if (!origin || whitelist.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,            // 쿠키 전송이 필요하면 true
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
};

// ③ 모든 라우트에 CORS 적용
app.use(cors(corsOptions));
// preflight 요청(OPTIONS)에 대해서도 CORS 헤더 보내기
app.options('*', cors(corsOptions));








app.use(express.json());
app.use(cookieParser());

app.use('/', authRoutes);
app.use('/', courseRoutes);
app.use('/', classRoutes);
app.use('/', codeRoutes);
app.use('/', uploadRoutes);
app.use('/', licenseRoutes);

// ✅ 서버 실행 전에 DB 동기화
(async () => {
  try {
    await db.sequelize.authenticate();
    console.log('✅ DB 연결 성공');
    await db.sequelize.sync({ force: false }); // 개발 중에만 true 가능
    console.log('✅ Sequelize 모델과 DB 동기화 완료');

    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ 서버 실행 실패:', err);
  }
})();
