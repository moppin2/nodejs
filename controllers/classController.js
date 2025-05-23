const { Class, Course, Instructor, License, ClassReservation,
    UploadFile, User, ClassFeedback, ClassReview, CourseApplication, ClassReservationHistory } = require('../models');
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

exports.getMyClassList = async (req, res) => {
    try {
        const now = new Date();
        const { id: userId, userType } = req.user;
        const instructor_id = userType === 'instructor' ? userId : undefined;
        const student_id = userType === 'user' ? userId : undefined;

        // 1) 공통 include: Course → Instructor, License
        const include = [{
            model: Course,
            as: 'course',
            attributes: ['id', 'title', 'license_id', 'instructor_id'],
            include: [
                { model: Instructor, as: 'instructor', attributes: ['id', 'name'] },
                { model: License, as: 'license', attributes: ['association', 'name'] }
            ],
            required: true,
            where: instructor_id
                ? { instructor_id }      // 강사 모드: 본인 과정만
                : undefined              // 학생 모드: 모든 과정 허용
        }];

        // 2) 학생 모드에만 예약 include
        if (student_id) {
            // a) 내 수강 중인 course_id 목록
            const apps = await CourseApplication.findAll({
                where: { user_id: student_id, status: 'approved' },
                attributes: ['course_id'], raw: true
            });
            const enrolledCourseIds = apps.map(a => a.course_id);

            include.push({
                model: ClassReservation,
                as: 'reservations',
                attributes: ['id', 'status', 'user_id'],
                where: { user_id: student_id },
                required: false
            });

            // b) 학생 전용 whereClause: 시작 전·예약 마감 전 & (내 예약 있거나 수강 중인 과정)
            var whereClause = {
                [Op.or]: [
                    // 1) 내 예약(언제든지)
                    { '$reservations.user_id$': student_id },

                    // 2) 수강중인 과정의 “앞으로 열리는” 수업만
                    enrolledCourseIds.length && {
                        course_id: { [Op.in]: enrolledCourseIds },
                        start_datetime: { [Op.gt]: now },
                        is_reservation_closed: false
                    }
                ].filter(Boolean)
            };
        }

        // 3) 강사 모드 whereClause: 별도 필요 없음 (include.where로 필터링)
        if (instructor_id) {
            var whereClause = {};
        }

        // 4) 조회
        const classes = await Class.findAll({
            where: whereClause,
            include,
            order: [['start_datetime', 'DESC']]
        });

        const classStartTimeListMap = {};
        classes.forEach(c => {
            classStartTimeListMap[c.id] = c.start_datetime;
        });

        // 5) 나머지 후처리(건수 집계, 매핑) — 기존 로직 그대로 유지
        const classIds = classes.map(c => c.id);
        // 상태별 카운트
        const reservationCounts = await ClassReservation.findAll({
            attributes: ['class_id', 'status', [fn('COUNT', col('id')), 'count']],
            where: {
                class_id: { [Op.in]: classIds },
                status: { [Op.in]: ['applied', 'approved', 'cancel_request'] }
            },
            group: ['class_id', 'status'],
            raw: true
        });
        const countMap = {};
        reservationCounts.forEach(r => {
            countMap[r.class_id] = countMap[r.class_id] || {};
            countMap[r.class_id][r.status] = parseInt(r.count, 10);
        });
        // 강사 아바타
        const instructorIds = [...new Set(classes.map(c => c.course.instructor_id))];
        const avatarFiles = await UploadFile.findAll({
            where: {
                target_type: 'instructor',
                target_id: { [Op.in]: instructorIds },
                purpose: 'profile',
                is_public: true
            }
        });
        const bucket = process.env.UPLOAD_BUCKET;
        const instructorAvatarMap = {};
        avatarFiles.forEach(f => {
            instructorAvatarMap[f.target_id] = `https://${bucket}.s3.amazonaws.com/${f.file_key}`;
        });

        // 강사 모드: 학생별 예약 리스트 매핑
        const reservationListMap = {};
        if (instructor_id) {
            const allRes = await ClassReservation.findAll({
                where: { class_id: { [Op.in]: classIds } },
                include: [{ model: User, as: 'user', attributes: ['id', 'name'] }]
            });
            const studentIds = [...new Set(allRes.map(r => r.user_id))];
            const studentFiles = await UploadFile.findAll({
                where: {
                    target_type: 'user',
                    target_id: { [Op.in]: studentIds },
                    purpose: 'profile',
                    is_public: true
                }
            });
            const studentAvatarMap = {};
            studentFiles.forEach(f => {
                studentAvatarMap[f.target_id] = `https://${bucket}.s3.amazonaws.com/${f.file_key}`;
            });
            classIds.forEach(id => reservationListMap[id] = []);
            allRes.forEach(r => {
                // 2) Lazy: 시작 후 상태 보정
                let effectiveStatus = r.status;
                const classStart = classStartTimeListMap[r.class_id];
                if (now >= classStart) {
                    if (r.status === 'applied') effectiveStatus = 'approved';
                    if (r.status === 'cancel_request') effectiveStatus = 'approved';
                }
                reservationListMap[r.class_id].push({
                    id: r.id,
                    status: effectiveStatus,
                    user: {
                        id: r.user.id,
                        name: r.user.name,
                        userType: 'user',
                        avatarUrl: studentAvatarMap[r.user.id] || null
                    }
                });
            });
        }

        // 학생 모드: 피드백·후기 맵
        const feedbackMap = {}, reviewMap = {};
        if (student_id) {
            (await ClassFeedback.findAll({
                where: { class_id: { [Op.in]: classIds }, user_id: student_id }
            })).forEach(fb => { feedbackMap[fb.class_id] = fb; });
            (await ClassReview.findAll({
                where: { class_id: { [Op.in]: classIds }, user_id: student_id }
            })).forEach(rv => { reviewMap[rv.class_id] = rv; });
        }

        // 6) 최종 조립
        const result = classes.map(c => {
            const totalReserved = ['applied', 'approved', 'cancel_request']
                .reduce((sum, s) => sum + (countMap[c.id]?.[s] || 0), 0);

            // class status 재계산 (optional)
            let status;
            if (now < c.start_datetime) {
                status = totalReserved < c.capacity ? 'reserved_open' : 'reserved_closed';
            } else if (now <= c.end_datetime) {
                status = 'in_progress';
            } else {
                status = 'completed';
            }

            const base = {
                id: c.id,
                title: c.title,
                start_datetime: c.start_datetime,
                end_datetime: c.end_datetime,
                capacity: c.capacity,
                reserved_count: totalReserved,
                status,
                instructor: {
                    id: c.course.instructor_id,
                    name: c.course.instructor?.name || '',
                    userType: 'instructor',
                    avatarUrl: instructorAvatarMap[c.course.instructor_id] || null
                },
                license_association: c.course.license?.association || '',
                license_name: c.course.license?.name || '',
                course_title: c.course.title
            };

            if (instructor_id) {
                return { ...base, reservations: reservationListMap[c.id] };
            }

            if (student_id) {
                const originalRes = (c.reservations || [])[0] || null;
                let effectiveStatus = originalRes?.status || null;

                // Lazy 처리: 수업 시작 이후 상태 보정
                if (originalRes && now >= new Date(c.start_datetime)) {
                    if (effectiveStatus === 'applied') {
                        effectiveStatus = 'approved';
                    } else if (effectiveStatus === 'cancel_request') {
                        effectiveStatus = 'approved';
                    }
                }

                return {
                    ...base,
                    myReservation: originalRes
                        ? { id: originalRes.id, status: effectiveStatus }
                        : null,
                    feedback: feedbackMap[c.id] || null,
                    review: reviewMap[c.id] || null
                };
            }

        });

        return res.json(result);
    }
    catch (err) {
        console.error('getMyClassList error:', err);
        return res.status(500).json({ error: err.message });
    }
};


exports.createReservation = async (req, res) => {
    try {
        const userId = req.user.id;
        const { class_id } = req.body;

        // 1) 해당 Class 존재 여부 확인
        const cls = await Class.findByPk(class_id);
        if (!cls) {
            return res.status(404).json({ message: '해당 수업을 찾을 수 없습니다.' });
        }


        if (new Date() >= cls.start_datetime || cls.is_reservation_closed === true) {
            return res.status(400).json({ message: '예약마감 이후에는 예약 할 수 없습니다.' });
        }

        // ——— 여기서 “정원 초과” 체크 ———
        const totalRequests = await ClassReservation.count({
            where: {
                class_id,
                status: { [Op.in]: ['applied', 'approved', 'cancel_request'] }
            }
        });
        if (totalRequests >= cls.capacity) {
            return res.status(400).json({ message: '예약 정원이 가득 찼습니다.' });
        }
        // ————————————————————————

        // 2) 사용자가 그 Course에 수강(승인) 상태인지 확인
        const hasCourse = await CourseApplication.findOne({
            where: {
                course_id: cls.course_id,
                user_id: userId,
                status: 'approved'         // 또는 여러분이 쓰는 승인 상태값
            }
        });
        if (!hasCourse) {
            return res.status(403).json({ message: '수강중인 과정의 수업만 예약할 수 있습니다.' });
        }

        // 3) 기존 예약 조회
        const existing = await ClassReservation.findOne({
            where: { class_id, user_id: userId }
        });

        let reservation;
        if (existing) {
            // 거절 상태, 취소상태였다면 다시 신청으로
            if (existing.status === 'rejected' || existing.status === 'cancelled') {
                existing.status = 'applied';
                await existing.save();
                reservation = existing;
            } else {
                return res.status(400).json({ message: '이미 예약 상태입니다.' });
            }
        } else {
            // 4) 신규 예약 생성
            reservation = await ClassReservation.create({
                class_id,
                user_id: userId
            });
        }

        // 5) 이력 기록
        await ClassReservationHistory.create({
            reservation_id: reservation.id,
            action: 'apply',
            performed_by: userId,
            performer_type: 'user',
            reason: null
        });

        return res.status(201).json(reservation);
    } catch (err) {
        console.error('createReservation error:', err);
        return res.status(500).json({ message: '서버 오류로 예약에 실패했습니다.' });
    }
};

exports.changeReservationStatus = async (req, res) => {
    try {
        const reservation = req.reservation;
        const { action } = req.body;
        const { id: userId, userType } = req.user;

        const statusMap = {
            approve: 'approved',
            reject: 'rejected',
            cancel: 'cancelled',
            cancel_request: 'cancel_request',
            cancel_approve: 'cancelled',
            cancel_deny: 'approved',    // approved 상태에서만 cancel_request 가능함
        };

        const newStatus = statusMap[action];
        if (!newStatus) {
            throw new Error(`알 수 없는 액션: ${action}`);
        }


        // 상태 업데이트
        reservation.status = newStatus;
        await reservation.save();

        // 이력 기록
        await ClassReservationHistory.create({
            reservation_id: reservation.id,
            action: action,
            performed_by: userId,
            performer_type: userType,
            reason: req.body.reason || null
        });

        res.json(reservation);
    } catch (err) {
        console.error('changeReservationStatus error:', err);
        res.status(500).json({ message: '서버 오류로 상태 변경에 실패했습니다.' });
    }
};