const { Course, CourseCompletionCriteria, UploadFile, License, Code, Instructor, CourseApplication, CourseApplicationHistory, User } = require('../models');
const { Op, fn, col } = require('sequelize');

exports.upsertCourse = async (req, res) => {

  try {
    const {
      id,
      title,
      license_id,
      level_code,
      region_code,
      curriculum,
      description,
      instructor_id = req.user.id,
      is_published,
      criteriaList = [],
      file_keys = [],
    } = req.body;

    let course;

    if (id) {
      // 기존 course 업데이트
      course = await Course.findByPk(id);
      if (!course) return res.status(404).json({ message: '과정을 찾을 수 없습니다.' });

      // ✅ 소유자 확인 (선택적: 내 강의만 수정 가능하도록)
      if (course.instructor_id !== req.user.id) {
        return res.status(403).json({ message: '본인의 과정만 수정할 수 있습니다.' });
      }

      // 완료된 수료기준이 있는 경우 로직 처리(개발할 것)

      await course.update({
        title,
        license_id,
        level_code,
        region_code,
        curriculum,
        description,
        instructor_id,
        is_published
      });

      // 기존 수료 기준 업데이트
      await updateCompletionCriteria(id, criteriaList);

      // 기존 사진파일 연결해제
      await UploadFile.update(
        { target_id: null },
        {
          where: {
            target_type: 'course',
            target_id: course.id,
            purpose: { [Op.in]: ['thumbnail', 'gallery'] }
          }
        }
      );

    } else {
      // 새로운 course 생성
      course = await Course.create({
        title,
        license_id,
        level_code,
        region_code,
        curriculum,
        description,
        instructor_id,
        is_published
      });

      // 수료 기준 삽입
      if (criteriaList.length > 0) {
        const values = criteriaList.map(c => ({
          course_id: course.id,
          type: c.type,
          value: c.value
        }));
        await CourseCompletionCriteria.bulkCreate(values);
      }
    }

    // 업로드 파일 id 업데이트
    if (file_keys.length > 0) {
      await UploadFile.update(
        { target_id: course.id },
        { where: { file_key: file_keys } }
      );
    }

    res.status(200).json({ message: '과정 저장 성공', courseId: course.id });
  } catch (err) {
    console.error('과정 저장 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

// exports.getCourseList = async (req, res) => {
//   try {
//     const {
//       instructor_id,
//       association_code,
//       license_id,
//       level_code,
//       region_code,
//       course_title,
//       instructor_name,
//       is_published,
//     } = req.query;

//     const whereClause = {};
//     if (instructor_id) {
//       whereClause.instructor_id = instructor_id;
//     } else {
//       whereClause.is_published = true;
//     }

//     if (license_id) whereClause.license_id = license_id;
//     if (level_code) whereClause.level_code = level_code;
//     if (region_code) whereClause.region_code = region_code;
//     if (course_title) whereClause.title = { [Op.like]: `%${course_title}%` };

//     const include = [
//       {
//         model: Instructor,
//         as: 'instructor',
//         attributes: ['name'],
//         where: instructor_name ? { name: { [Op.like]: `%${instructor_name}%` } } : undefined,
//         required: !!instructor_name,
//       },
//       {
//         model: License,
//         as: 'license',
//         attributes: ['association', 'name'],
//         where: association_code ? { association: association_code } : undefined,
//       },
//       {
//         model: Code,
//         as: 'level',
//         attributes: ['name'],
//         where: { group_code: 'LEVEL' },
//         required: false,
//       },
//       {
//         model: Code,
//         as: 'region',
//         attributes: ['name'],
//         where: { group_code: 'REGION' },
//         required: false,
//       },
//     ];

//     const courses = await Course.findAll({
//       where: whereClause,
//       include,
//       order: [
//         ['is_published', 'DESC'],    // true(1)가 위로, false(0)가 아래로
//         ['created_at', 'DESC']       // 최신 생성일 순
//       ]
//     });
//     const courseIds = courses.map(c => c.id);

//     // 썸네일 매핑
//     const thumbnails = await UploadFile.findAll({
//       where: {
//         target_type: 'course',
//         target_id: { [Op.in]: courseIds },
//         purpose: 'thumbnail',
//         is_public: true,
//       },
//     });

//     const bucket = process.env.UPLOAD_BUCKET;
//     const thumbnailMap = {};
//     thumbnails.forEach(f => {
//       thumbnailMap[f.target_id] = `https://${bucket}.s3.amazonaws.com/${f.file_key}`;
//     });

//     // ✅ 과정별 신청자 / 승인자 수 조회
//     const applicationCounts = await CourseApplication.findAll({
//       attributes: [
//         'course_id',
//         'status',
//         [fn('COUNT', col('id')), 'count']
//       ],
//       where: { course_id: { [Op.in]: courseIds } },
//       group: ['course_id', 'status'],
//       raw: true
//     });

//     const countMap = {}; // { [course_id]: { applied: X, approved: Y } }
//     for (const row of applicationCounts) {
//       if (!countMap[row.course_id]) countMap[row.course_id] = {};
//       countMap[row.course_id][row.status] = parseInt(row.count, 10);
//     }

//     // 결과 조립
//     const result = courses.map(c => ({
//       id: c.id,
//       title: c.title,
//       thumbnail_url: thumbnailMap[c.id] || null,
//       instructor_name: c.instructor?.name || '',
//       license_association: c.license?.association || '',
//       license_name: c.license?.name || '',
//       level_name: c.level?.name || '',
//       region_name: c.region?.name || '',
//       applied_count: countMap[c.id]?.applied || 0,
//       approved_count: countMap[c.id]?.approved || 0,
//       is_published: c.is_published
//     }));

//     res.json(result);
//   } catch (err) {
//     console.error('과정 리스트 조회 실패:', err);
//     res.status(500).json({ message: '서버 오류' });
//   }
// };

exports.getCourseList = async (req, res) => {
  try {
    const {
      instructor_id,
      association_code,
      license_id,
      level_code,
      region_code,
      course_title,
      instructor_name,
      is_published,
    } = req.query;

    const whereClause = {};
    if (instructor_id) {
      whereClause.instructor_id = instructor_id;
    } else {
      whereClause.is_published = true;
    }

    if (license_id) whereClause.license_id = license_id;
    if (level_code) whereClause.level_code = level_code;
    if (region_code) whereClause.region_code = region_code;
    if (course_title) whereClause.title = { [Op.like]: `%${course_title}%` };

    const include = [
      {
        model: Instructor,
        as: 'instructor',
        attributes: ['name'],
        where: instructor_name ? { name: { [Op.like]: `%${instructor_name}%` } } : undefined,
        required: !!instructor_name,
      },
      {
        model: License,
        as: 'license',
        attributes: ['association', 'name'],
        where: association_code ? { association: association_code } : undefined,
      },
      {
        model: Code,
        as: 'level',
        attributes: ['name'],
        where: { group_code: 'LEVEL' },
        required: false,
      },
      {
        model: Code,
        as: 'region',
        attributes: ['name'],
        where: { group_code: 'REGION' },
        required: false,
      },
    ];
    // 기존 쿼리 파싱 & Course.findAll 부분 생략…

    const courses = await Course.findAll({
      where: whereClause,
      include,
      order: [
        ['is_published', 'DESC'],
        ['created_at', 'DESC'],
      ],
    });

    const courseIds = courses.map(c => c.id);
    const instructorIds = courses
      .map(c => c.instructor_id)
      .filter(id => !!id);

    // 썸네일 매핑 (기존)
    const thumbnails = await UploadFile.findAll({
      where: {
        target_type: 'course',
        target_id: { [Op.in]: courseIds },
        purpose: 'thumbnail',
        is_public: true,
      },
    });
    const bucket = process.env.UPLOAD_BUCKET;
    const thumbnailMap = {};
    thumbnails.forEach(f => {
      thumbnailMap[f.target_id] = `https://${bucket}.s3.amazonaws.com/${f.file_key}`;
    });

    // ✅ 과정별 신청자 / 승인자 수 조회
    const applicationCounts = await CourseApplication.findAll({
      attributes: [
        'course_id',
        'status',
        [fn('COUNT', col('id')), 'count']
      ],
      where: { course_id: { [Op.in]: courseIds } },
      group: ['course_id', 'status'],
      raw: true
    });

    const countMap = {}; // { [course_id]: { applied: X, approved: Y } }
    for (const row of applicationCounts) {
      if (!countMap[row.course_id]) countMap[row.course_id] = {};
      countMap[row.course_id][row.status] = parseInt(row.count, 10);
    }

    // ➕ 강사 아바타 매핑
    const avatarFiles = await UploadFile.findAll({
      where: {
        target_type: 'instructor',
        target_id: { [Op.in]: instructorIds },
        purpose: 'profile',
        is_public: true,
      },
    });
    const instructorAvatarMap = {};
    avatarFiles.forEach(f => {
      instructorAvatarMap[f.target_id] = `https://${bucket}.s3.amazonaws.com/${f.file_key}`;
    });

    // 결과 조립
    const result = courses.map(c => ({
      id: c.id,
      title: c.title,
      thumbnail_url: thumbnailMap[c.id] || null,
      instructor_name: c.instructor?.name || '',
      instructor: {
        id: c.instructor_id,
        userType: 'instructor',
        name: c.instructor?.name || ''
      },
      instructor_avatar_url: instructorAvatarMap[c.instructor_id] || null,
      license_association: c.license?.association || '',
      license_name: c.license?.name || '',
      level_name: c.level?.name || '',
      region_name: c.region?.name || '',
      applied_count: countMap[c.id]?.applied || 0,
      approved_count: countMap[c.id]?.approved || 0,
      is_published: c.is_published,
    }));

    res.json(result);
  } catch (err) {
    console.error('과정 리스트 조회 실패:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};


exports.getCourseDetail = async (req, res) => {
  const { id } = req.params;
  try {
    const course = await Course.findByPk(id, {
      include: [
        {
          model: License,
          as: 'license',
          attributes: ['id', 'name', 'association']
        },
        {
          model: Code,
          as: 'level',
          attributes: ['code', 'name'],
          where: { group_code: 'LEVEL' },
          required: false,
        },
        {
          model: Code,
          as: 'region',
          attributes: ['code', 'name'],
          where: { group_code: 'REGION' },
          required: false,
        },
        {
          model: Instructor,
          as: 'instructor',
          attributes: ['id', 'name']
        },
      ]
    });

    if (!course) return res.status(404).json({ message: '과정을 찾을 수 없습니다.' });

    const criteriaList = await CourseCompletionCriteria.findAll({
      where: { course_id: id },
      attributes: ['type', 'value']
    });

    const files = await UploadFile.findAll({
      where: {
        target_type: 'course',
        target_id: id,
        purpose: { [Op.in]: ['thumbnail', 'gallery'] },
      },
      attributes: ['file_key', 'purpose', 'file_name']
    });

    const bucket = process.env.UPLOAD_BUCKET;
    const coverImage = files.find(f => f.purpose === 'thumbnail');
    const galleryImages = files.filter(f => f.purpose === 'gallery');

    res.json({
      id: course.id,
      title: course.title,
      license_id: course.license_id,
      level_code: course.level_code,
      region_code: course.region_code,
      curriculum: course.curriculum,
      description: course.description,
      instructor_id: course.instructor_id,
      instructor_name: course.instructor?.name,
      license_name: course.license?.name,
      license_association: course.license?.association,
      level_name: course.level?.name,
      region_name: course.region?.name,
      is_published: course.is_published,
      criteriaList,
      coverImageKey: coverImage?.file_key || null,
      coverImageUrl: coverImage ? `https://${bucket}.s3.amazonaws.com/${coverImage.file_key}` : null,
      galleryImages: galleryImages.map((f) => ({
        file_key: f.file_key,
        file_name: f.file_name,
        url: `https://${bucket}.s3.amazonaws.com/${f.file_key}`,
      })),
    });
  } catch (err) {
    console.error('과정 상세 조회 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

const updateCompletionCriteria = async (courseId, criteriaList) => {
  // 1. 기존 기준 불러오기
  const existing = await CourseCompletionCriteria.findAll({
    where: { course_id: courseId }
  });

  const existingIds = existing.map(c => c.id);
  const newIds = criteriaList.filter(c => c.id).map(c => c.id);

  // 2. 삭제 대상 = 기존에 있었는데 요청에는 없는 것
  const toDelete = existingIds.filter(id => !newIds.includes(id));

  if (toDelete.length > 0) {
    await CourseCompletionCriteria.destroy({
      where: { id: toDelete }
    });
  }

  // 4. 수정
  const toUpdate = criteriaList.filter(c => c.id && existingIds.includes(c.id));
  for (const item of toUpdate) {
    await CourseCompletionCriteria.update(
      { type: item.type, value: item.value },
      { where: { id: item.id } }
    );
  }

  // 5. 추가
  const toCreate = criteriaList.filter(c => !c.id);
  if (toCreate.length > 0) {
    await CourseCompletionCriteria.bulkCreate(
      toCreate.map(c => ({
        course_id: courseId,
        type: c.type,
        value: c.value
      }))
    );
  }
};

exports.applyToCourse = async (req, res) => {
  if (!req.user || req.user.userType !== 'user') {
    return res.status(403).json({ message: '학생만 수강 신청할 수 있습니다.' });
  }

  const { course_id } = req.body;
  const user_id = req.user.id;

  if (!course_id) {
    return res.status(400).json({ message: 'course_id는 필수입니다.' });
  }

  try {
    const course = await Course.findByPk(course_id);
    if (!course || !course.is_published) {
      return res.status(404).json({ message: '존재하지 않거나 비공개인 과정입니다.' });
    }

    // 중복 신청 방지: 신청 중 또는 승인 상태인 경우
    const existing = await CourseApplication.findOne({
      where: {
        course_id,
        user_id,
        status: ['applied', 'approved']
      }
    });

    if (existing) {
      return res.status(409).json({ message: '이미 신청한 과정입니다.' });
    }

    // 신청 저장
    const application = await CourseApplication.create({
      course_id,
      user_id,
      status: 'applied'
    });

    // 이력 저장
    await CourseApplicationHistory.create({
      application_id: application.id,
      action: 'apply',
      performed_by: user_id,
      performer_type: 'user',
      reason: null
    });

    return res.status(200).json({ message: '수강 신청이 완료되었습니다.' });
  } catch (err) {
    console.error('수강 신청 오류:', err);
    return res.status(500).json({ message: '서버 오류' });
  }
};

exports.getPendingEnrollmentsByInstructor = async (req, res) => {
  try {
    const instructorId = req.user.id;
    const { courseId } = req.params;


    const whereClause = { instructor_id: instructorId };
    if (courseId) {
      whereClause.id = courseId; // 특정 과정만 조회
    }

    // 본인이 등록한 과정 중 신청자(applied)가 있는 과정 목록
    const courses = await Course.findAll({
      where: whereClause,
      include: [
        {
          model: CourseApplication,
          as: 'applications',
          where: { status: 'applied' },
          include: [
            {
              model: User,
              as: 'user',
              attributes: ['id', 'name', 'email'],
            },
          ],
          required: true,
        },
      ],
      order: [['id', 'DESC']],
    });

    const result = courses.map(course => ({
      course_id: course.id,
      course_title: course.title,
      pending_users: course.applications.map(app => ({
        application_id: app.id,
        id: app.user.id,
        name: app.user.name,
        email: app.user.email,
        applied_at: app.created_at,
      })),
    }));

    res.json(result);
  } catch (err) {
    console.error('등록요청 목록 조회 실패:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

exports.approveCourseApplications = async (req, res) => {
  const { application_ids = [] } = req.body;

  if (!Array.isArray(application_ids) || application_ids.length === 0) {
    return res.status(400).json({ message: 'application_ids는 배열로 전달되어야 합니다.' });
  }

  try {
    // 신청 정보 + 과정 정보 함께 조회
    const applications = await CourseApplication.findAll({
      where: {
        id: application_ids,
        status: 'applied',
      },
      include: {
        model: Course,
        as: 'course',
        attributes: ['instructor_id'],
      },
    });

    // 일부 누락 또는 상태 불일치
    if (applications.length !== application_ids.length) {
      return res.status(400).json({ message: '신청 상태가 올바르지 않거나 존재하지 않는 신청이 있습니다.' });
    }

    // 본인 과정인지 검증
    const unauthorized = applications.find(app => app.course.instructor_id !== req.user.id);
    if (unauthorized) {
      return res.status(403).json({ message: '본인의 과정에 대한 신청만 승인할 수 있습니다.' });
    }

    // 승인 처리
    for (const app of applications) {
      await app.update({ status: 'approved' });

      await CourseApplicationHistory.create({
        application_id: app.id,
        action: 'approve',
        performed_by: req.user.id,
        performer_type: 'instructor',
        reason: null,
      });
    }

    res.json({ message: '승인이 완료되었습니다.' });
  } catch (err) {
    console.error('수강 승인 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

exports.rejectCourseApplications = async (req, res) => {
  const { application_ids = [], reason } = req.body;

  if (!Array.isArray(application_ids) || application_ids.length === 0) {
    return res.status(400).json({ message: 'application_ids는 배열로 전달되어야 합니다.' });
  }

  try {
    // 신청 정보 + 과정 정보 함께 조회
    const applications = await CourseApplication.findAll({
      where: {
        id: application_ids,
        status: 'applied',
      },
      include: {
        model: Course,
        as: 'course',
        attributes: ['instructor_id'],
      },
    });

    // 일부 누락 또는 상태 불일치
    if (applications.length !== application_ids.length) {
      return res.status(400).json({ message: '신청 상태가 올바르지 않거나 존재하지 않는 신청이 있습니다.' });
    }

    // 본인 과정인지 검증
    const unauthorized = applications.find(app => app.course.instructor_id !== req.user.id);
    if (unauthorized) {
      return res.status(403).json({ message: '본인의 과정에 대한 신청만 거절절할 수 있습니다.' });
    }

    // 거절 처리
    for (const app of applications) {
      await app.update({ status: 'rejected' });

      await CourseApplicationHistory.create({
        application_id: app.id,
        action: 'reject',
        performed_by: req.user.id,
        performer_type: 'instructor',
        reason,
      });
    }

    res.json({ message: '거절절이 완료되었습니다.' });
  } catch (err) {
    console.error('수강 거절 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};
