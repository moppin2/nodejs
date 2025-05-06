const { Course, CourseCompletionCriteria } = require('../models');

exports.upsertCourse = async (req, res) => {
    if (!req.user || req.user.userType !== 'instructor') {
        return res.status(403).json({ message: '강사만 과정 등록이 가능합니다.' });
      }

    try {
        const {
        id,
        title,
        association_code,
        level_code,
        region_code,
        curriculum,
        description,
        instructor_id,
        criteriaList = []
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
            association_code,
            level_code,
            region_code,
            curriculum,
            description,
            instructor_id
        });

        // 기존 수료 기준 삭제 후 재삽입
        await CourseCompletionCriteria.destroy({ where: { course_id: id } });
    } else {
      // 새로운 course 생성
      course = await Course.create({ 
        title,
        association_code,
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

    res.status(200).json({ message: '과정 저장 성공', courseId: course.id });
  } catch (err) {
    console.error('과정 저장 오류:', err);
    res.status(500).json({ message: '서버 오류' });
  }
};

