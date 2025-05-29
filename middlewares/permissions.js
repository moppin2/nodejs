const { Course, ClassReservation, Class, ClassFeedback } = require('../models');
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
  try {
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

    // 피드백 관련 이미지 업로드
    // --- 피드백 관련 이미지 업로드 권한 로직 (사용자 요청 반영) ---
    if (target_type === 'feedback' && ['gallery'].includes(purpose)) { // 'purpose'는 상황에 맞게 정의
      // 1. 공통 기본 권한: 승인된 강사여야 함
      if (user.userType !== 'instructor' || user.status !== 'approved') {
        return res.status(403).json({ message: '승인된 강사만 피드백 이미지를 업로드할 수 있습니다.' });
      }

      // 2. target_id (feedback_id)가 있는 경우 (기존 피드백에 이미지 추가/수정 시)
      if (target_id) {
        const feedback = await ClassFeedback.findByPk(target_id);
        if (!feedback) {
          return res.status(404).json({ message: '피드백 정보를 찾을 수 없습니다.' });
        }

        // feedback으로부터 class_id를 가져와서 해당 class의 강사인지 확인
        const targetClass = await Class.findByPk(feedback.class_id, {
          include: [{
            model: Course,
            as: 'course', // 모델 관계 설정 시 정의한 alias
            attributes: ['instructor_id']
          }]
        });

        if (!targetClass) {
          // 이 경우는 데이터 정합성에 문제가 있을 수 있음 (피드백에 유효하지 않은 class_id가 있는 경우)
          return res.status(404).json({ message: '피드백에 연결된 수업 정보를 찾을 수 없습니다.' });
        }

        // 해당 수업을 개설한 강사인지 확인
        if (!targetClass.course || targetClass.course.instructor_id !== user.id) {
          return res.status(403).json({ message: '해당 피드백이 속한 수업의 강사만 이미지를 업로드할 수 있습니다.' });
        }
        // 모든 검증 통과 (수정 시)
        return next();
      } else {
        // target_id가 없는 경우 (새 피드백 생성 중 이미지 업로드):
        // "생성일때는 승인된 강사인지만 체크하고 그냥 통과" -> 이미 위에서 userType과 status를 체크했으므로 통과.
        // 이 Presigned URL 발급 단계에서는 특정 class나 student에 대한 연결 정보를 알 수 없으므로,
        // 해당 정보는 프론트에서 피드백 본문 저장 시 또는 /api/upload/record 단계에서
        // 올바른 target_id(새로 생성된 feedback_id)와 함께 처리되어야 합니다.
        return next();
      }
    }

    if (target_type === 'review' && ['gallery'].includes(purpose)) {
      // 1. 기본 권한: 학생(user)만 리뷰 이미지 업로드 가능
      if (user.userType !== 'user') {
        return res.status(403).json({ message: '학생만 리뷰 이미지를 업로드할 수 있습니다.' });
      }

      // 2. target_id (review_id)가 있는 경우 (기존 리뷰에 이미지 추가/수정 시)
      if (target_id) {
        const review = await ClassReview.findByPk(target_id);
        if (!review) {
          return res.status(404).json({ message: '리뷰 정보를 찾을 수 없습니다.' });
        }
        // 본인 리뷰에만 이미지 업로드 가능
        if (review.user_id !== user.id) {
          return res.status(403).json({ message: '자신의 리뷰에만 이미지를 업로드할 수 있습니다.' });
        }

        // 해당 리뷰가 속한 수업 정보 확인
        const targetClassForReview = await Class.findByPk(review.class_id);
        if (!targetClassForReview) {
          return res.status(404).json({ message: '리뷰에 연결된 수업 정보를 찾을 수 없습니다.' });
        }
        // 수업 종료 후 리뷰 이미지 업로드 가능 (정책에 따라)
        if (targetClassForReview.end_datetime && new Date(targetClassForReview.end_datetime) > now) {
          return res.status(403).json({ message: '수업 종료 후 리뷰 관련 이미지를 업로드할 수 있습니다.' });
        }
        // 해당 학생이 수업에 참여했는지 확인
        const reservation = await ClassReservation.findOne({
          where: { class_id: review.class_id, user_id: user.id, status: 'approved' }
        });
        if (!reservation) {
          return res.status(403).json({ message: '해당 수업을 수강한 학생만 리뷰 이미지를 업로드할 수 있습니다.' });
        }
        return next(); // 모든 검증 통과 (수정 시)
      } else {
        // // target_id가 없는 경우 (새 리뷰 작성 중 이미지 업로드):
        // // 프론트에서 class_id를 보내줘야 함 (req.body.class_id)
        // if (!class_id) {
        //   return res.status(400).json({ message: '새 리뷰 이미지 업로드 시 대상 수업(class_id) 정보가 필요합니다.' });
        // }
        // const targetClassForNewReview = await Class.findByPk(class_id);
        // if (!targetClassForNewReview) {
        //   return res.status(404).json({ message: '리뷰를 작성할 수업을 찾을 수 없습니다.' });
        // }
        // // 수업 종료 후 리뷰 이미지 업로드 가능 (정책에 따라)
        // if (targetClassForNewReview.end_datetime && new Date(targetClassForNewReview.end_datetime) > now) {
        //   return res.status(403).json({ message: '수업 종료 후 리뷰 관련 이미지를 업로드할 수 있습니다.' });
        // }
        // // 해당 학생이 수업에 참여했는지 확인
        // const reservationForNewReview = await ClassReservation.findOne({
        //   where: { class_id: Number(class_id), user_id: user.id, status: 'approved' }
        // });
        // if (!reservationForNewReview) {
        //   return res.status(403).json({ message: '해당 수업을 수강한 학생만 리뷰 이미지를 업로드할 수 있습니다.' });
        // }
        return next(); // 생성 시 기본 검증 통과
      }
    }

    return res.status(403).json({ message: '지원하지 않는 업로드 요청이거나 파일 업로드 권한이 없습니다.' });


  } catch (error) {
    console.error('Upload permission check error:', error);
    return res.status(500).json({ message: '서버 내부 오류가 발생했습니다.' });
  }
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
  const reservation = await ClassReservation.findByPk(reservationId, {
    include: [{
      model: Class,
      as: 'class',
      attributes: ['start_datetime', 'is_reservation_closed']
    }]
  });
  if (!reservation) {
    return res.status(404).json({ message: '예약을 찾을 수 없습니다.' });
  }

  if (new Date() >= reservation.class.start_datetime || reservation.class.is_reservation_closed) {
    return res.status(400).json({ message: '예약 마감 또는 수업 시작 이후에는 상태를 변경할 수 없습니다.' });
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
