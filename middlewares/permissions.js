const { Course } = require('../models');

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


module.exports = { permissionGuard, checkUploadPermission, checkCoursePermission };
