const { Course, ClassReservation, Class } = require('../models');
const { Op } = require('sequelize');

function permissionGuard({ allowedRoles = [], allowedStatus = [] }) {
  return (req, res, next) => {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: '인증되지 않은 사용자입니다.' });
    }

    if (allowedRoles.length && !allowedRoles.includes(user.userType)) {
      return res.status(403).json({ message: '권한이 없습니다.' });
    }

    if (allowedStatus.length && user.status && !allowedStatus.includes(user.status)) {
      return res.status(403).json({ message: '현재 상태에서는 접근할 수 없습니다.' });
    }

    next();
  };
}

const checkUploadPermission = async (req, res, next) => {
  const { target_type, target_id, purpose } = req.body;
  const user = req.user;

  // 업로드 하는 모든 로직에 적용해야함.

  // 강사 가입 문서
  if (target_type === 'instructor' && purpose === 'verification') {
    if (user.userType === 'instructor' &&
      user.id === Number(target_id) &&
      ['draft', 'rejected'].includes(user.status)) {
      return next();
    }
    return res.status(403).json({ message: '업로드 권한이 없습니다.' });
  }

  // 과정 썸네일, 사진 => 수정 시 경우 본인만 업로드가능, 생성 시 승인된 강사만 업로드 가능
  if (target_type === 'course' && ['thumbnail', 'gallery'].includes(purpose)) {
    if (user.userType !== 'instructor' || user.status !== 'approved') {
      return res.status(403).json({ message: '승인된 강사만 업로드할 수 있습니다.' });
    }

    if (target_id) {
      const course = await Course.findByPk(target_id);
      if (!course) return res.status(404).json({ message: '과정을 찾을 수 없습니다.' });
      if (course.instructor_id !== user.id) {
        return res.status(403).json({ message: '해당 과정에 대한 업로드 권한이 없습니다.' });
      }
    }
    return next();
  }
  return res.status(403).json({ message: '지원하지 않는 업로드 요청입니다.' });
};

const checkCoursePermission = async (req, res, next) => {
  const courseId = req.params.id;
  const user = req.user;

  try {
    const course = await Course.findByPk(courseId);

    if (!course) {
      return res.status(404).json({ message: '과정을 찾을 수 없습니다.' });
    }

    // 비공개 과정이면 → 강사 본인만 접근 가능
    if (!course.is_published) {
      if (!user || user.userType !== 'instructor' || user.id !== course.instructor_id) {
        return res.status(403).json({ message: '비공개 과정은 본인만 접근 가능합니다.' });
      }
    }

    req.course = course; // 필요하면 다음 미들웨어/핸들러에서 course 정보 사용
    next();
  } catch (err) {
    console.error('checkCoursePermission 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};


// type: DataTypes.ENUM(
//     'applied',       // 예약 신청
//     'approved',      // 예약 승인
//     'rejected',      // 예약 거부
//     'cancel_request',// 취소 요청
//     'cancelled'      // 예약 취소


// type: DataTypes.ENUM(
//     'apply',          // 예약 신청 => 학생
//     'approve',        // 예약 승인 => 강사
//     'reject',         // 예약 거부 => 강사
//     'cancel',         // 예약 신청 => 학생/강사
//     'cancel_request', // 취소 요청 => 학생
//     'cancel_approve', // 취소 승인 => 강사
//     'cancel_deny'     // 취소 거부 => 강사

// 허용 가능한 상태 전환 맵
const ALLOWED_TRANSITIONS = {
  user: {
    applied: ['cancel'],
    approved: ['cancel_request']
  },
  instructor: {
    applied: ['approve', 'reject'],
    cancel_request: ['cancel_approve', 'cancel_deny'],
    approved: ['cancel']
  }
};

const validateReservationTransition = async (req, res, next) => {
  const { id: reservationId } = req.params;
  const { action } = req.body;
  const { id: userId, userType } = req.user;



  // 1) 타겟 예약 조회
  const reservation = await ClassReservation.findByPk(reservationId);
  if (!reservation) {
    return res.status(404).json({ message: '예약을 찾을 수 없습니다.' });
  }

  if (new Date() >= reservation.class.start_datetime) {
    return res.status(400).json({ message: '수업 시작 이후에는 상태를 변경할 수 없습니다.' });
  }


  // 2) 권한 검사
  if (userType === 'user') {
    if (reservation.user_id !== userId) {
      return res.status(403).json({ message: '본인의 예약만 변경할 수 있습니다.' });
    }
  } else if (userType === 'instructor') {
    // 강사라면 자신의 클래스 소유 여부 확인
    const cls = await Class.findByPk(reservation.class_id, {
      include: [{ model: Course, as: 'course', attributes: ['instructor_id'] }]
    });
    if (!cls || cls.course.instructor_id !== userId) {
      return res.status(403).json({ message: '본인 수업의 예약만 변경할 수 있습니다.' });
    }
  } else {
    return res.status(403).json({ message: '권한이 없습니다.' });
  }

  // 3) 전환 허용 여부 검사
  const from = reservation.status;
  const allowed = (ALLOWED_TRANSITIONS[userType] || {})[from] || [];
  if (!allowed.includes(action)) {
    return res.status(400).json({
      message: `상태 전환 불가: ${from} → ${action}`
    });
  }

  //수업 시작시간이 지나거나 마감 완료 되었을때 처리

  // 4) 검증 통과: 다음 미들웨어/컨트롤러에서 사용하도록 붙여두기
  req.reservation = reservation;
  next();
}

module.exports = { permissionGuard, checkUploadPermission, checkCoursePermission, validateReservationTransition };
