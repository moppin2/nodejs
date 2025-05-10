const { Course, CourseCompletionCriteria, UploadFile, License, Code, Instructor } = require('../models');
const { Op } = require('sequelize');

exports.upsertCourse = async (req, res) => {
  if (!req.user || req.user.userType !== 'instructor') {
    return res.status(403).json({ message: '강사만 과정 등록이 가능합니다.' });
  }

  try {
    const {
      id,
      title,
      license_id,
      level_code,
      region_code,
      curriculum,
      description,
      instructor_id,
      criteriaList = [],
      file_keys = [],
    } = req.body;

    let course;

    if (id) {
      // 기존 course 업데이트
      course = await Course.findByPk(id);
      if (!course) return res.status(404).json({ message: '과정을 찾을 수 없습니다.' });

      // ✅ 소유자 확인 (선택적: 내 강의만 수정 가능하도록)
      if (course.instructor_id !== instructor_id) {
        return res.status(403).json({ message: '본인의 과정만 수정할 수 있습니다.' });
      }

      await course.update({
        title,
        license_id,
        level_code,
        region_code,
        curriculum,
        description,
        instructor_id
      });

      // 기존 수료 기준 삭제
      await CourseCompletionCriteria.destroy({ where: { course_id: id } });

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
        instructor_id
      });
    }

    // 수료 기준 삽입
    if (criteriaList.length > 0) {
      const values = criteriaList.map(c => ({
        course_id: course.id,
        type: c.type,
        value: c.value
      }));
      await CourseCompletionCriteria.bulkCreate(values);
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

exports.getCourseList = async (req, res) => {
  try {
    const { instructor_id } = req.query;
    const where = {};

    if (instructor_id) {
      where.instructor_id = instructor_id;
    }

    const courses = await Course.findAll({
      where,
      include: [
        {
          model: Instructor,
          as: 'instructor',
          attributes: ['name']
        },
        {
          model: License,
          as: 'license',
          attributes: ['association', 'name'],
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
      ],
    });

    const courseIds = courses.map((c) => c.id);

    const thumbnails = await UploadFile.findAll({
      where: {
        target_type: 'course',
        target_id: { [Op.in]: courseIds },
        purpose: 'thumbnail',
        is_public: true,
      },
    });

    const thumbnailMap = {};
    const bucket = process.env.UPLOAD_BUCKET;
    thumbnails.forEach((f) => {
      thumbnailMap[f.target_id] = `https://${bucket}.s3.amazonaws.com/${f.file_key}`;
    });

    const result = courses.map((c) => ({
      id: c.id,
      title: c.title,
      thumbnail_url: thumbnailMap[c.id] || null,
      instructor_name: c.instructor?.name || '',
      license_association: c.license?.association || '',
      license_name: c.license?.name || '',
      level_name: c.level?.name || '',
      region_name: c.region?.name || '',
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
