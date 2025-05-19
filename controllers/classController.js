const { Class, Course, Instructor, License, ClassReservation, UploadFile } = require('../models');
const { Op, fn, col } = require('sequelize');

exports.upsertClass = async (req, res) => {
    try {
        const data = req.body;
        const instructorId = req.user.id; // 로그인된 강사 ID

        // 1) 과정 소유권 검증 (없으면 403)
        const course = await Course.findOne({
            where: { id: data.course_id, instructor_id: instructorId }
        });
        if (!course) {
            return res.status(403).json({ error: '해당 과정에 대한 권한이 없습니다.' });
        }

        // 1.5) 일시 순서 검증: 종료 ≤ 시작인 경우 에러
        if (data.start_datetime && data.end_datetime) {
            const start = new Date(data.start_datetime);
            const end = new Date(data.end_datetime);
            if (end <= start) {
                return res
                    .status(400)
                    .json({ error: '종료 일시는 시작 일시보다 이후여야 합니다.' });
            }
        }

        // 2) 수정 모드: data.id가 있으면 해당 수업 찾고, 없으면 404
        if (data.id) {
            const cls = await Class.findOne({
                where: { id: data.id, course_id: data.course_id }
            });
            if (!cls) {
                return res.status(404).json({ error: '수업을 찾을 수 없습니다.' });
            }
            await cls.update(data);
            return res.json(cls);
        }

        // 3) 생성 모드: 바로 생성
        const cls = await Class.create(data);
        return res.json(cls);

    } catch (err) {
        console.error('Class upsert error:', err);
        return res.status(500).json({ error: err.message });
    }
};


exports.getClassList = async (req, res) => {
    try {
        const { instructor_id, user_id, class_title } = req.query;

        // 1) 최소 하나는 필수
        if (!instructor_id && !user_id) {
            return res
                .status(400)
                .json({ error: 'instructor_id 또는 user_id 중 하나를 포함해야 합니다.' });
        }

        // 2) Class.where 절 (제목 검색)
        const whereClause = {};
        if (class_title) {
            whereClause.title = { [Op.like]: `%${class_title}%` };
        }

        // 3) Include 관계 준비
        const include = [
            {
                model: Course,
                as: 'course',
                attributes: ['id', 'title', 'license_id', 'instructor_id'],
                include: [
                    {
                        model: Instructor,
                        as: 'instructor',
                        attributes: ['id', 'name']
                    },
                    {
                        model: License,
                        as: 'license',
                        attributes: ['association', 'name']
                    }
                ],
                // 강사용 필터
                where: instructor_id
                    ? { instructor_id }
                    : undefined
            },
            {
                model: ClassReservation,
                as: 'reservations',
                attributes: [],          // 개별 데이터는 필요 없으니 빈 배열
                where: user_id
                    ? { user_id }
                    : undefined,
                required: Boolean(user_id)
            }
        ];

        // 4) 실제 조회
        const classes = await Class.findAll({
            where: whereClause,
            include,
            order: [['start_datetime', 'ASC']]
        });

        // 5) 예약 승인된 수 카운트
        const classIds = classes.map(c => c.id);
        const reservationCounts = await ClassReservation.findAll({
            attributes: [
                'class_id',
                'status',
                [fn('COUNT', col('id')), 'count']
            ],
            where: {
                class_id: { [Op.in]: classIds }
            },
            group: ['class_id', 'status'],
            raw: true
        });

        // ➕ 6) 강사 아바타 파일 조회
        const instructorIds = classes
            .map(c => c.course.instructor_id)
            .filter(id => !!id);
        const avatarFiles = await UploadFile.findAll({
            where: {
                target_type: 'instructor',
                target_id: { [Op.in]: instructorIds },
                purpose: 'profile',
                is_public: true,   // 필요 없으면 제거하세요
            }
        });
        const bucket = process.env.UPLOAD_BUCKET;
        const instructorAvatarMap = {};
        avatarFiles.forEach(f => {
            instructorAvatarMap[f.target_id] =
                `https://${bucket}.s3.amazonaws.com/${f.file_key}`;
        });

        const countMap = {};
        reservationCounts.forEach(row => {
            if (!countMap[row.class_id]) countMap[row.class_id] = {};
            countMap[row.class_id][row.status] = parseInt(row.count, 10);
        });

        // 6) 결과 포맷 + status 계산
        const now = new Date();
        const result = classes.map(c => {
            const reservedCount = countMap[c.id]?.approved || 0;
            let status;

            if (now < c.start_datetime) {
                // 수업 시작 전
                status = (!c.is_reservation_closed && reservedCount < c.capacity)
                    ? 'reserved_open'
                    : 'reserved_closed';
            } else if (now >= c.start_datetime && now <= c.end_datetime) {
                // 진행 중
                status = 'in_progress';
            } else {
                // 수업 종료 후 → 피드백 전
                status = 'awaiting_feedback';
                // 만약 피드백 완료 여부를 알 수 있는 필드가 있다면:
                // status = c.is_feedback_completed ? 'completed' : 'awaiting_feedback';
            }

            return {
                id: c.id,
                title: c.title,
                start_datetime: c.start_datetime,
                end_datetime: c.end_datetime,
                capacity: c.capacity,
                reserved_count: reservedCount,
                instructor_name: c.course.instructor.name,
                instructor: {
                    id: c.course.instructor_id,
                    userType: 'instructor',
                    name: c.course.instructor.name || ''
                },
                instructor_avatar_url: instructorAvatarMap[c.course.instructor_id] || null,
                license_association: c.course.license.association,
                license_name: c.course.license.name,
                course_title: c.course.title,
                status   // ← 새로 추가된 상태 필드
            };
        });

        return res.json(result);
    } catch (err) {
        console.error('getClassList error:', err);
        return res.status(500).json({ error: err.message });
    }
};
