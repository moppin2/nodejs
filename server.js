const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { PORT, CLIENT_URL } = require('./config');

const db = require('./models')

const authRoutes = require('./routes/authRoutes');
const courseRoutes = require('./routes/courseRoutes');
const codeRoutes = require('./routes/codeRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const licenseRoutes = require('./routes/licenseRoutes');

const app = express();

app.use(cors({
  origin: CLIENT_URL,
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());

app.use('/', authRoutes);
app.use('/', courseRoutes);
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
