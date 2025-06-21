const { ChatRoom, ChatRoomParticipant, ChatMessage, FcmToken } = require('./models');
const cookie = require('cookie');
const { Server } = require("socket.io");
const authService = require('./services/authService');
const admin = require('firebase-admin');
const { getMessaging } = require('firebase-admin/messaging');
const serviceAccount = require('./config/serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

function setupSocketIO(httpServer, jwtSecret) {
    const io = new Server(httpServer, { //서버 시작 시 한 번 실행됨
        cors: {
            origin: process.env.CLIENT_URL || "http://localhost:3000", // 클라이언트 주소
            methods: ["GET", "POST"],
            credentials: true
        }
    });

    // Socket.IO 인증 미들웨어 => 클라이언트에서 접속 시도 시 실행됨
    io.use(async (socket, next) => {
        // 1) HTTP-only 쿠키에서 먼저 꺼내본다
        let token;
        if (socket.handshake.headers.cookie) {
            const parsed = cookie.parse(socket.handshake.headers.cookie);
            token = parsed.accessToken;   // httpOnly 쿠키로 발급된 토큰
        }

        // 2) 쿠키에 없으면 클라이언트가 보낸 auth.token 사용
        if (!token && socket.handshake.auth && socket.handshake.auth.token) {
            token = socket.handshake.auth.token;
        }

        if (!token) {
            console.log('Socket Auth: No token provided for socket', socket.id);
            return next(new Error('인증 오류: 토큰이 제공되지 않았습니다.'));
        }

        try {
            // authService의 함수를 사용하여 토큰 검증 및 사용자 정보 가져오기
            // verifyTokenAndGetUser 함수가 jwtSecret을 내부적으로 사용하거나, 인자로 받을 수 있도록 수정 필요
            // 여기서는 authService가 JWT_SECRET을 내부적으로 알고 있다고 가정
            const user = await authService.verifyTokenAndGetUser(token);

            if (!user || !user.id || !user.userType) { // 반환된 user 객체 유효성 검사
                console.error('Socket Auth: Invalid user data from token for socket', socket.id);
                return next(new Error('인증 오류: 유효하지 않은 토큰 또는 사용자 정보입니다.'));
            }

            socket.user = user; // socket 객체에 사용자 정보 첨부
            console.log(`Socket Auth: User ${user.id} (${user.userType}) authenticated for socket ${socket.id}`);
            next(); // 인증 성공
        } catch (err) {
            console.error(`Socket Auth: Token verification failed for socket ${socket.id} -`, err.message);
            next(new Error(err.message || '인증 오류: 토큰이 유효하지 않습니다.'));
        }
    });

    // io.use 미들웨어로 인증에 성공하면 실제로 연결됨
    io.on('connection', (socket) => {
        console.log(`사용자 ${socket.user.id} (${socket.user.userType}) 연결됨: ${socket.id}`);

        // 예시: 개인 룸에 자동 참여
        // socket.join(`user_room_${socket.user.id}`);
        // console.log(`User ${socket.user.id} joined personal room: user_room_${socket.user.id}`);

        // 온라인 사용자 관리 로직 (예시)
        // global.onlineUsers = global.onlineUsers || new Map();
        // global.onlineUsers.set(socket.user.id, { socketId: socket.id, userType: socket.user.userType });
        // io.emit('online_users_updated', Array.from(global.onlineUsers.keys()));


        socket.on('disconnect', (reason) => {
            console.log(`사용자 ${socket.user.id} (${socket.user.userType}) 연결 해제됨: ${socket.id}, 이유: ${reason}`);
            // if (global.onlineUsers) {
            //     global.onlineUsers.delete(socket.user.id);
            //     io.emit('online_users_updated', Array.from(global.onlineUsers.keys()));
            // }
            // 해당 소켓이 참여했던 모든 룸에서 자동으로 leave 처리됨
        });

        // 다른 채팅 관련 이벤트 리스너들...
        socket.on('join_room', (data) => {
            socket.join(data.roomId);
            console.log(`User ${socket.id} joined room ${data.roomId}`);

            const clients = io.of("/").adapter.rooms.get(data.roomId);
            if (clients) {
                console.log(`현재 ${data.roomId} 방의 참가자 수:`, clients.size);
                console.log(`참가자 socket id 목록:`, Array.from(clients));
            }
        });

        socket.on('send_chat_message', async (data) => {
            try {
                const { roomId, content, senderId, message_type = 'text' } = data;
                const sender = socket.user; // { id, userType }

                // 1) DB에 메시지 저장
                const saved = await ChatMessage.create({
                    chat_room_id: roomId,
                    sender_type: socket.user.userType, // 예: 'user'
                    sender_id: senderId,               // 예: 17
                    content: content,
                    message_type: message_type,
                    created_at: new Date()
                });

                // 2) 브로드캐스트할 때는 저장된 레코드를 그대로 보내자
                //    프론트에서는 saved.id, saved.created_at 등을 사용할 수 있음
                const payload = {
                    id: saved.id,
                    roomId: saved.chat_room_id,
                    sender: {
                        id: saved.sender_id,
                        userType: saved.sender_type,
                        // 필요하다면 추가 정보(이름, avatar)도 채워서 보낼 수 있음
                    },
                    content: saved.content,
                    message_type: saved.message_type,
                    createdAt: saved.created_at
                };
                // const payload = data;
                io.to(roomId).emit('new_chat_message', payload);

                // 3) FCM 푸시 발송: 같은 룸의 다른 참가자들 대상
                //    - ChatRoomParticipant에서 roomId 참가자 조회
                //    - 참가자의 FCM 토큰 목록 조회
                const participants = await ChatRoomParticipant.findAll({
                    where: { chat_room_id: roomId }
                });

                // 토큰 배열 수집 (본인은 제외)
                const tokens = [];
                for (const p of participants) {
                    if (p.user_type === sender.userType && p.user_id === sender.id) continue;

                    const userTokens = await FcmToken.findAll({
                        where: {
                            user_id: p.user_id,
                            user_type: p.user_type
                        }
                    });
                    userTokens.forEach(t => tokens.push(t.fcm_token));
                }

                if (tokens.length > 0) {
                    // 푸시 메시지 구성
                    const message = {
                        notification: {
                            title: `새 채팅 메시지`,
                            body: content.length > 50 ? content.slice(0, 47) + '...' : content,
                        },
                        data: {
                            roomId: String(roomId),
                            messageId: String(saved.id)
                        },
                        tokens: tokens
                    };

                    // 멀티캐스트 전송
                    const response = await getMessaging().sendEachForMulticast(message);
                    console.log(`FCM: ${response.successCount} 성공, ${response.failureCount} 실패`);
                }

            } catch (err) {
                console.error('send_chat_message error:', err);
                // 문제가 생겨도 서버가 죽지 않도록 랩
            }
        });
        // io.to(data.roomId).emit('new_chat_message', data);
        // console.log(data);

        // const clients = io.of("/").adapter.rooms.get(data.roomId);
        // if (clients) {
        //     console.log(`현재 ${data.roomId} 방의 참가자 수:`, clients.size);
        //     console.log(`참가자 socket id 목록:`, Array.from(clients));
        // }
        // });
    });

    console.log('Socket.IO 서버가 HTTP 서버에 연결 설정 완료.');
    return io;
}

module.exports = setupSocketIO;