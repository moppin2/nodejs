const { User, Instructor, UploadFile, Course, CourseApplication } = require('../models');

exports.getProfile = async (req, res) => {
  try {
    const { type, id } = req.params;
    const validTypes = ['user', 'instructor'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ message: '잘못된 프로필 타입입니다.' });
    }
    const pk = Number(id);
    if (Number.isNaN(pk)) {
      return res.status(400).json({ message: '잘못된 ID입니다.' });
    }

    // 1) 공통 조회
    const Model = type === 'user' ? User : Instructor;
    const profile = await Model.findByPk(pk);
    if (!profile) {
      return res.status(404).json({ message: `${type}를 찾을 수 없습니다.` });
    }

    // 2) 공통 아바타 URL
    const file = await UploadFile.findOne({
      where: {
        target_type: type,
        target_id: pk,
        purpose: 'profile',
        is_public: true
      },
      order: [['created_at', 'DESC']]
    });
    const bucket = process.env.UPLOAD_BUCKET;
    const avatarUrl = file
      ? `https://${bucket}.s3.amazonaws.com/${file.file_key}`
      : null;

    // // 3) 타입별 추가 데이터
    // let extra = {};
    // if (type === 'instructor') {
    //   // 예: 강사가 등록한 과정 수
    //   const courseCount = await Course.count({ where: { instructor_id: pk } });
    //   extra = { courseCount };
    // } else {
    //   // 일반 유저: 승인된 수강 신청 수
    //   const enrolledCount = await CourseApplication.count({
    //     where: { user_id: pk, status: 'approved' }
    //   });
    //   extra = { enrolledCount };
    // }

    // 4) 응답 조립
    const data = {
      id:        profile.id,
      name:      profile.name,
      username:  profile.username,
      userType:  profile.userType,
      joinedAt:  profile.joined_at,
      avatarUrl,
    }

    if (type==='instructor'){
        data.careerYears = profile.career_years;
        data.mainExperience = profile.main_experience;
        data.comment = profile.comment;
    }

    return res.json(data);
  } catch (err) {
    console.error('getProfile 오류:', err);
    return res.status(500).json({ message: '서버 오류' });
  }
};
