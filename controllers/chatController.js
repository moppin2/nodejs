// controllers/chatController.js

const { sequelize, ChatRoom, ChatRoomParticipant, Class, ClassReservation, Course, User, Instructor, Admin, UploadFile, ChatMessage } = require('../models');
const { Op } = require('sequelize');

const bucket = process.env.UPLOAD_BUCKET;

exports.getOrCreateClassChatRoom = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const user = req.user; // { id, userType }
    const { classId } = req.params;

    // 1) 클래스 + 관련 코스 + 유효한 예약(학생)들을 한 번에 조회
    const cls = await Class.findOne({
      where: { id: classId },
      include: [
        {
          model: Course,
          as: 'course',
          attributes: ['instructor_id'],
        },
        {
          model: ClassReservation,
          as: 'reservations',
          where: {
            status: { [Op.notIn]: ['cancelled', 'rejected'] }
          },
          required: false, // 예약이 없어도 ok
          attributes: ['user_id']
        }
      ],
      transaction: t
    });

    if (!cls) {
      await t.rollback();
      return res.status(404).json({ message: '해당 수업을 찾을 수 없습니다.' });
    }

    // 1.1) Course를 통해 강사 ID 가져오기
    const instructorId = cls.course?.instructor_id;
    if (!instructorId) {
      await t.rollback();
      return res.status(404).json({ message: '해당 수업의 강사를 찾을 수 없습니다.' });
    }

    // 2) 채팅방 조회 (room_type='class', related_class_id=classId)
    let chatRoom = await ChatRoom.findOne({
      where: { room_type: 'class', related_class_id: classId },
      transaction: t
    });

    // 3) 채팅방이 없으면 새로 생성하고, 강사 + 예약된 학생 모두 참가시키기
    if (!chatRoom) {
      chatRoom = await ChatRoom.create({
        room_type: 'class',
        related_class_id: classId,
        title: `수업 ${cls.title} 채팅방`
      }, { transaction: t });

      // 3.1) 강사 참가
      await ChatRoomParticipant.create({
        chat_room_id: chatRoom.id,
        user_type: 'instructor',
        user_id: instructorId,
        joined_at: new Date()
      }, { transaction: t });

      // 3.2) 유효한 학생들(cls.reservations) 모두 채팅방에 참가자로 등록
      for (const r of cls.reservations) {
        await ChatRoomParticipant.create({
          chat_room_id: chatRoom.id,
          user_type: 'user',
          user_id: r.user_id,
          joined_at: new Date()
        }, { transaction: t });
      }
    }

    // 4) 현재 요청자(user)가 채팅방 참여자인지 확인
    const isParticipant = await ChatRoomParticipant.findOne({
      where: {
        chat_room_id: chatRoom.id,
        user_type: user.userType,
        user_id: user.id
      },
      transaction: t
    });

    if (!isParticipant) {
      await t.rollback();
      return res.status(403).json({ message: '채팅방에 대한 접근 권한이 없습니다.' });
    }

    // 5) 성공 시 커밋하여 roomId 반환
    await t.commit();
    return res.json({ roomId: chatRoom.id });

  } catch (err) {
    await t.rollback();
    console.error('getOrCreateClassChatRoom error:', err);
    return res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
};

exports.getChatRoomDetail = async (req, res) => {
  try {
    const { roomId } = req.params;

    // 1) 채팅방 기본 정보
    const room = await ChatRoom.findByPk(roomId, {
      attributes: ['id', 'title', 'room_type', 'related_class_id', 'related_course_id']
    });
    if (!room) {
      return res.status(404).json({ message: '해당 채팅방을 찾을 수 없습니다.' });
    }

    // 2) 참가자 ID & 타입 조회
    const parts = await ChatRoomParticipant.findAll({
      where: { chat_room_id: roomId },
      attributes: ['user_id', 'user_type']
    });

    // 3) 참가자별 프로필(이름+아바타) 조회
    const participants = await Promise.all(parts.map(async p => {
      // 3.1) 이름 조회
      let profileRec;
      switch (p.user_type) {
        case 'instructor':
          profileRec = await Instructor.findByPk(p.user_id, { attributes: ['name'] });
          break;
        case 'admin':
          profileRec = await Admin.findByPk(p.user_id, { attributes: ['name'] });
          break;
        default:
          profileRec = await User.findByPk(p.user_id, { attributes: ['name'] });
      }
      const name = profileRec?.name || null;

      // 3.2) UploadFile 에서 프로필 사진 조회
      const avatarFile = await UploadFile.findOne({
        where: {
          target_type: p.user_type,
          target_id: p.user_id,
          purpose: 'profile',
          is_public: true
        },
        attributes: ['file_key']
      });
      const avatarUrl = avatarFile
        ? `https://${bucket}.s3.amazonaws.com/${avatarFile.file_key}`
        : null;

      return {
        user_id: p.user_id,
        user_type: p.user_type,
        name,
        avatarUrl
      };
    }));

    // 4) 결과 반환
    return res.json({
      room: room.toJSON(),
      participants
    });

  } catch (err) {
    console.error('getChatRoomDetail error:', err);
    return res.status(500).json({ message: '채팅방 정보 조회 중 오류가 발생했습니다.' });
  }
};

/**
 * 무한 스크롤용 메시지 조회
 * - 초기 호출: 가장 최근 limit 개 메시지
 * - before 파라미터 있을 때: before 시점 이전 limit 개 메시지
 * - after 파라미터 있을 때: after 시점 이후 메시지 모두
 */
exports.listChatMessages = async (req, res) => {
  try {
    const { roomId } = req.params;
    // limit 지정 (기본 20개)
    const limit = parseInt(req.query.limit, 10) || 20;
    const where = { chat_room_id: roomId };

    let order, messages;

    if (req.query.before) {
      // older messages for infinite scroll
      where.created_at = { [Op.lt]: new Date(req.query.before) };
      order = [['created_at', 'DESC']];
      messages = await ChatMessage.findAll({ where, order, limit });
      // 역순으로 돌려서 오래된 게 앞쪽에 오도록
      messages = messages.reverse();

    } else if (req.query.after) {
      // 새로 들어온 메시지들
      where.created_at = { [Op.gt]: new Date(req.query.after) };
      order = [['created_at', 'ASC']];
      messages = await ChatMessage.findAll({ where, order });

    } else {
      // 초기 로드: 최신 limit 개
      order = [['created_at', 'DESC']];
      messages = await ChatMessage.findAll({ where, order, limit });
      messages = messages.reverse();
    }

    return res.json(messages);
  } catch (err) {
    console.error('listChatMessages error:', err);
    return res
      .status(500)
      .json({ message: '메시지 조회 중 오류가 발생했습니다.' });
  }
};