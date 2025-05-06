const mysql = require('mysql2/promise');

async function testConnection() {
  const connection = await mysql.createConnection({
    host: 'localhost',      // 또는 'localhost'
    port: 3306,              // 도커에서 열어준 포트
    user: 'moppin',          // 본인이 만든 계정
    password: '2331',
    database: 'mydb'
  });

  console.log('✅ MySQL 접속 성공!');
  
  const [rows] = await connection.execute('SELECT NOW() AS now');
  console.log('서버 시간:', rows[0].now);

  await connection.end();
}

testConnection().catch((err) => {
  console.error('❌ 접속 실패:', err.message);
});