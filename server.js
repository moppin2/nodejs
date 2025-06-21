const express = require('express');
const http = require('http');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { PORT, CLIENT_URL, ACCESS_SECRET } = require('./config');
const db = require('./models')
const setupSocketIO = require('./socketSetup');

const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const registerRoutes = require('./routes/registerRoutes');
const courseRoutes = require('./routes/courseRoutes');
const classRoutes = require('./routes/classRoutes');
const codeRoutes = require('./routes/codeRoutes');
const fileRoutes = require('./routes/fileRoutes');
const licenseRoutes = require('./routes/licenseRoutes');
const chatRoutes = require('./routes/chatRoutes');
const fcmTokenRoutes = require('./routes/fcmTokenRoutes');

const app = express();
const httpServer = http.createServer(app);


// ***************운영반영 시 원복***************
// app.use(cors({
//   origin: CLIENT_URL,
//   credentials: true
// }));
// ***************운영반영 시 원복***************



// ***************운영반영 시 삭제***************
// ① 허용할 Origin 목록 (개발 중이라면 * 도 무방)
const whitelist = [
  'http://localhost:3000',
  'http://henrykim.co.kr',
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
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

// ③ 모든 라우트에 CORS 적용
app.use(cors(corsOptions));
// preflight 요청(OPTIONS)에 대해서도 CORS 헤더 보내기
app.options('*', cors(corsOptions));
// ***************운영반영 시 삭제***************




app.use(express.json());
app.use(cookieParser());

app.use('/', authRoutes);
app.use('/', userRoutes);
app.use('/', registerRoutes);
app.use('/', courseRoutes);
app.use('/', classRoutes);
app.use('/', codeRoutes);
app.use('/', fileRoutes);
app.use('/', licenseRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/fcm-token', fcmTokenRoutes);


const io = setupSocketIO(httpServer, ACCESS_SECRET); // JWT_SECRET_KEY 전달

// ✅ 서버 실행 전에 DB 동기화
(async () => {
  try {
    await db.sequelize.authenticate();
    console.log('✅ DB 연결 성공');
    await db.sequelize.sync({ force: false }); // 개발 중에만 true 가능
    console.log('✅ Sequelize 모델과 DB 동기화 완료');

    // app.listen(PORT, () => {
    //   console.log(`🚀 Server running on http://localhost:${PORT}`);

    httpServer.listen(PORT, () => { // Express 앱(app)이 아닌 httpServer를 리스닝
      console.log(`🚀 Server (HTTP & Socket.IO) running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ 서버 실행 실패:', err);
  }
})();
