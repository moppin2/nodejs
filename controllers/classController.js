const { Class, Course, Instructor, License, ClassReservation, CourseCompletionCriteria, StudentCourseProgress,
    UploadFile, User, ClassFeedback, ClassReview, CourseApplication, ClassReservationHistory } = require('../models');
const { Op, fn, col } = require('sequelize');
const s3Service = require('../services/s3Service');

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
            // --- 추가 시작: 이 예약들에 해당하는 모든 학생 피드백 한 번에 조회 ---
            const studentFeedbackMap = {};
            if (allRes.length > 0) {
                const feedbackQueryConditions = allRes.map(res => ({
                    class_id: res.class_id,
                    user_id: res.user_id
                    // instructor_id: instructor_id, // ClassFeedback 모델에 instructor_id가 있다면 추가 가능
                }));

                const feedbackAttributes = [
                    'id', 'feedback_text', 'rating', 'is_public', 'class_id', 'user_id',
                    'is_publication_requested', 'publish_requested_at',
                    'publish_approved', 'publish_approved_at',
                    'publish_rejected', 'publish_rejected_at', 'reject_reason'
                ];

                const allStudentFeedbacks = await ClassFeedback.findAll({
                    where: {
                        [Op.or]: feedbackQueryConditions
                    },
                    attributes: feedbackAttributes
                });

                allStudentFeedbacks.forEach(fb => {
                    // 각 class_id 와 user_id 조합을 키로 사용하여 피드백 객체 저장
                    studentFeedbackMap[`c${fb.class_id}_u${fb.user_id}`] = fb.get({ plain: true });
                });
            }
            // --- 추가 끝 ---
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
                const currentStudentFeedback = studentFeedbackMap[`c${r.class_id}_u${r.user_id}`] || null;
                reservationListMap[r.class_id].push({
                    id: r.id,
                    status: effectiveStatus,
                    user: {
                        id: r.user.id,
                        name: r.user.name,
                        userType: 'user',
                        avatarUrl: studentAvatarMap[r.user.id] || null
                    },
                    feedback: currentStudentFeedback
                });
            });
        }

        // 학생 모드: 피드백·후기 맵
        const feedbackMap = {}, reviewMap = {};
        if (student_id) {
            const feedbackAttributes = [ // 명시적으로 필요한 속성들 (이전 답변에서 추가했던 부분)
                'id', 'feedback_text', 'rating', 'is_public', 'class_id', 'user_id',
                'is_publication_requested', 'publish_requested_at',
                'publish_approved', 'publish_approved_at',
                'publish_rejected', 'publish_rejected_at', 'reject_reason'
            ];
            (await ClassFeedback.findAll({
                where: {
                    class_id: { [Op.in]: classIds },
                    user_id: student_id,
                    is_publication_requested: { [Op.not]: null }
                },
                attributes: feedbackAttributes // 가져올 필드 명시
            })).forEach(fbInstance => { // fbInstance로 변경하여 .get() 사용 명시
                feedbackMap[fbInstance.class_id] = fbInstance.get({ plain: true }); // plain 객체로 변환
            });

            (await ClassReview.findAll({
                where: { class_id: { [Op.in]: classIds }, user_id: student_id }
                // attributes: [...] // 필요시 리뷰 속성도 명시
            })).forEach(rvInstance => { // rvInstance로 변경
                reviewMap[rvInstance.class_id] = rvInstance.get({ plain: true }); // plain 객체로 변환
            });
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

exports.createFeedback = async (req, res) => {
    const {
        class_id,       // 피드백 대상 수업 ID
        user_id,        // 피드백 대상 학생(User) ID
        feedback_text,
        rating,
        file_keys = [], // MultiImageUploader에서 전달된 file_key 배열
        passed_criterion_ids = [] // 프론트에서 전달된, 이번에 통과한 기준 ID 목록
    } = req.body;

    const instructorId = req.user.id; // 현재 로그인한 강사 ID (authMiddleware를 통해 설정됨)
    const now = new Date();

    // Sequelize 트랜잭션 시작
    const t = await ClassFeedback.sequelize.transaction();

    try {
        // 1. 필수 값 검증
        if (!class_id || !user_id || !feedback_text) {
            await t.rollback();
            return res.status(400).json({ message: '수업 ID, 학생 ID, 피드백 내용은 필수입니다.' });
        }
        if (rating === undefined || rating === null) {
            await t.rollback();
            return res.status(400).json({ message: '평점은 필수입니다.' });
        }

        // 2. 권한 검증: 요청한 강사가 해당 수업의 실제 강사인지 확인
        const targetClass = await Class.findByPk(class_id, {
            include: [{
                model: Course,
                as: 'course',
                attributes: ['instructor_id', 'id'] // course_id도 StudentCourseProgress에 필요
            }],
            transaction: t // 트랜잭션에 포함
        });

        if (!targetClass) {
            await t.rollback();
            return res.status(404).json({ message: '수업을 찾을 수 없습니다.' });
        }

        if (!targetClass.course || targetClass.course.instructor_id !== instructorId) {
            await t.rollback();
            return res.status(403).json({ message: '해당 수업의 강사만 피드백을 작성할 수 있습니다.' });
        }

        // 수업 종료 여부 확인
        if (targetClass.end_datetime && new Date(targetClass.end_datetime) > now) {
            await t.rollback();
            return res.status(403).json({ message: '수업 종료 후 피드백 작성 가능합니다.' });
        }

        // 3. 해당 학생 참여 검증
        const reservation = await ClassReservation.findOne({
            where: {
                class_id: Number(class_id),
                user_id: Number(user_id),
                status: 'approved'
            },
            transaction: t
        });
        if (!reservation) {
            await t.rollback();
            return res.status(403).json({ message: '해당 수업에 참여한 학생이 아니거나 예약 상태가 올바르지 않습니다.' });
        }

        // 4. 중복 피드백 방지
        const existingFeedback = await ClassFeedback.findOne({
            where: { class_id: Number(class_id), user_id: Number(user_id) },
            transaction: t
        });
        if (existingFeedback) {
            await t.rollback();
            return res.status(409).json({ message: '이미 해당 학생에 대한 이 수업의 피드백이 존재합니다. 수정을 이용해주세요.' });
        }

        // 5. ClassFeedback 레코드 생성
        const newFeedback = await ClassFeedback.create({
            class_id: Number(class_id),
            user_id: Number(user_id),
            feedback_text,
            rating: Number(rating),
            is_publication_requested: null,
            publish_requested_at: null,
            publish_approved: false,
            publish_rejected: false,
            reject_reason: null,
            is_public: false
        }, { transaction: t });

        // 6. 파일 연결 업데이트
        if (file_keys && file_keys.length > 0) {
            await UploadFile.update(
                {
                    target_id: newFeedback.id,
                    target_type: 'feedback'
                },
                {
                    where: { file_key: { [Op.in]: file_keys } },
                    transaction: t
                }
            );
        }

        // --- 7. 수료 기준 통과 정보 저장 로직 추가 ---
        if (targetClass.course?.id && passed_criterion_ids && passed_criterion_ids.length > 0) {
            for (const criterionId of passed_criterion_ids) {
                // findOrCreate: 해당 학생이 이 기준을 이미 통과했으면 찾고, 아니면 새로 생성
                // StudentCourseProgress 모델에 (user_id, criterion_id) UNIQUE 제약조건이 있어야 함
                const [progress, created] = await StudentCourseProgress.findOrCreate({
                    where: {
                        user_id: Number(user_id),
                        criterion_id: Number(criterionId)
                    },
                    defaults: { // 새로 생성될 때의 기본값
                        user_id: Number(user_id),
                        criterion_id: Number(criterionId),
                        class_id: Number(class_id), // 이 수업에서 통과 처리됨
                        // course_id: targetClass.course.id, // StudentCourseProgress 모델에 course_id가 있다면
                        // passed_at: new Date(), // 모델에서 제거했으므로 created_at 자동 생성 활용
                        notes: `Feedback ID ${newFeedback.id}에서 통과 처리됨`,
                    },
                    transaction: t
                });
                // if (created) { console.log(`Student ${user_id} passed criterion ${criterionId} in class ${class_id}`); }
                // else { console.log(`Student ${user_id} already passed criterion ${criterionId}`); }
            }
        }
        // --- 수료 기준 통과 정보 저장 로직 끝 ---

        await t.commit(); // 모든 작업 성공 시 트랜잭션 커밋

        res.status(201).json({
            message: '피드백이 성공적으로 생성되었습니다.',
            feedbackId: newFeedback.id,
            feedback: newFeedback
        });

    } catch (err) {
        await t.rollback(); // 오류 발생 시 트랜잭션 롤백
        console.error('피드백 생성 오류:', err);
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: '이미 해당 학생에 대한 이 수업의 피드백이 존재합니다. 수정을 이용해주세요.' });
        }
        res.status(500).json({ message: '서버 오류로 인해 피드백 생성에 실패했습니다.' });
    }
};

exports.updateFeedback = async (req, res) => {
    const { feedbackId } = req.params;
    const {
        feedback_text,
        rating,
        file_keys = [],
        passed_criterion_ids = []
    } = req.body;
    const instructorId = req.user.id;

    const t = await ClassFeedback.sequelize.transaction();

    try {
        // 1. 피드백 존재 여부 및 강사 권한 확인
        const feedback = await ClassFeedback.findByPk(feedbackId, {
            include: [{
                model: Class,
                as: 'class',
                include: [{
                    model: Course,
                    as: 'course',
                    attributes: ['id', 'instructor_id']
                }]
            }],
            transaction: t
        });

        if (!feedback) {
            await t.rollback();
            return res.status(404).json({ message: '피드백을 찾을 수 없습니다.' });
        }

        if (!feedback.class || !feedback.class.course || feedback.class.course.instructor_id !== instructorId) {
            await t.rollback();
            return res.status(403).json({ message: '해당 피드백을 수정할 권한이 없습니다.' });
        }

        // 2. 피드백 수정 가능 상태 검증
        if (feedback.is_publication_requested !== null) {
            await t.rollback();
            return res.status(403).json({ message: '임시 저장 상태의 피드백만 내용을 수정할 수 있습니다.' });
        }

        // 3. 피드백 내용 업데이트
        const updateData = {};
        if (feedback_text !== undefined) updateData.feedback_text = feedback_text;
        if (rating !== undefined) updateData.rating = Number(rating);

        updateData.is_publication_requested = null;
        updateData.publish_requested_at = null;
        updateData.publish_approved = false;
        updateData.publish_rejected = false;
        updateData.reject_reason = null;
        updateData.is_public = false;

        await feedback.update(updateData, { transaction: t });

        // 4. 파일 연결 업데이트
        await UploadFile.update(
            { target_id: null },
            {
                where: {
                    target_type: 'feedback',
                    target_id: feedback.id,
                },
                transaction: t
            }
        );
        if (file_keys && file_keys.length > 0) {
            await UploadFile.update(
                { target_id: feedback.id, target_type: 'feedback' },
                {
                    where: { file_key: { [Op.in]: file_keys } },
                    transaction: t
                }
            );
        }


        const studentId = feedback.user_id;
        const classId = feedback.class_id;
        const courseId = feedback.class.course.id;

        // 5a. 이 수업(classId)에서 이 학생(studentId)이 통과한 것으로 기록된 모든 StudentCourseProgress 레코드를 삭제합니다.
        await StudentCourseProgress.destroy({
            where: {
                user_id: studentId,
                class_id: classId
            },
            transaction: t
        });

        // 5b. 프론트엔드에서 새로 전달된 passed_criterion_ids에 대해서만 StudentCourseProgress 레코드를 생성 (findOrCreate)
        if (courseId && passed_criterion_ids && passed_criterion_ids.length > 0) {
            for (const criterionId of passed_criterion_ids) {
                await StudentCourseProgress.findOrCreate({
                    where: {
                        user_id: studentId,
                        criterion_id: Number(criterionId)
                    },
                    defaults: {
                        user_id: studentId,
                        criterion_id: Number(criterionId),
                        class_id: classId,
                        notes: `Feedback ID ${feedback.id}에서 통과 처리됨 (수정 시점)`,
                    },
                    transaction: t
                });
            }
        }

        await t.commit();

        res.status(200).json({
            message: '피드백이 성공적으로 수정되었습니다.',
            feedback: await feedback.reload()
        });

    } catch (err) {
        await t.rollback();
        console.error('피드백 수정 오류:', err);
        res.status(500).json({ message: '서버 오류로 인해 피드백 수정에 실패했습니다.' });
    }
};


exports.getFeedbackDetails = async (req, res) => {
    const { feedbackId } = req.params;
    const requestingUser = req.user; // { id, userType, status }

    try {
        const feedback = await ClassFeedback.findByPk(feedbackId, {
            include: [
                {
                    model: User, // 피드백을 받은 학생 정보
                    as: 'user', // ClassFeedback 모델과 User 모델 간의 관계 alias
                    attributes: ['id', 'name', 'email'] // 필요한 학생 정보 필드 선택
                },
                {
                    model: Class,
                    as: 'class', // ClassFeedback 모델과 Class 모델 간의 관계 alias
                    attributes: ['id', 'title', 'course_id'],
                    include: [{
                        model: Course,
                        as: 'course', // Class 모델과 Course 모델 간의 관계 alias
                        attributes: ['id', 'title', 'instructor_id'],
                        // 필요하다면 Course에 연결된 Instructor 정보도 가져올 수 있습니다.
                        // include: [{ model: Instructor, as: 'instructor', attributes: ['id', 'name'] }]
                    }]
                }
            ],
            // ClassFeedback 모델에서 가져올 필드 명시 (모두 가져오려면 생략 가능)
            // attributes: ['id', 'feedback_text', 'rating', /*... 모든 상태 필드 ...*/]
        });

        if (!feedback) {
            return res.status(404).json({ message: '피드백을 찾을 수 없습니다.' });
        }

        // --- 권한 검증 ---
        // 피드백 수정은 주로 강사가 하므로, 강사 위주로 검증.
        // 학생 본인도 자신의 피드백을 조회할 수 있게 하려면 조건 추가.
        let isAuthorized = false;
        if (requestingUser.userType === 'instructor' &&
            feedback.class && feedback.class.course &&
            feedback.class.course.instructor_id === requestingUser.id) {
            isAuthorized = true;
        } else if (requestingUser.userType === 'user' && feedback.user_id === requestingUser.id && feedback.is_publication_requested !== null) {
            // 학생 본인이 자신의 피드백을 조회하는 경우 (수정은 불가하더라도 조회는 가능하게)
            isAuthorized = true;
        }
        // 관리자(admin)도 조회 가능하게 하려면:
        // else if (requestingUser.userType === 'admin') {
        //     isAuthorized = true;
        // }

        if (!isAuthorized) {
            return res.status(403).json({ message: '이 피드백을 조회할 권한이 없습니다.' });
        }

        // --- 첨부된 이미지 파일 정보 조회 ---
        const images = await UploadFile.findAll({
            where: {
                target_type: 'feedback',
                target_id: feedback.id
            },
            attributes: ['id', 'file_key', 'file_name', 'is_public' /*, 기타 필요한 필드 */]
        });

        const imageObjects = await Promise.all(images.map(async (img) => {
            let displayUrl = null;

            try {
                // S3 서비스 함수 호출
                displayUrl = await s3Service.generatePresignedGetUrl(img.file_key);
            } catch (s3Error) {
                console.error(`Error getting presigned URL for feedback image ${img.file_key} from s3Service:`, s3Error);
                // URL 생성 실패 시 어떻게 처리할지 결정 (예: null 유지, 기본 이미지 URL 등)
            }

            return {
                id: img.id,
                file_key: img.file_key,
                name: img.file_name,
                url: displayUrl, // Pre-signed URL
            };
        }));

        const responseData = {
            ...feedback.get({ plain: true }),
            images: imageObjects
        };

        res.status(200).json(responseData);

    } catch (err) {
        console.error('피드백 상세 조회 오류:', err);
        res.status(500).json({ message: '서버 오류로 피드백 조회에 실패했습니다.' });
    }
};


/**
 * 강사가 피드백에 대해 학생에게 공개를 요청합니다.
 */
exports.requestFeedbackPublication = async (req, res) => {
    const { feedbackId } = req.params;
    const instructorId = req.user.id;

    try {
        const feedback = await ClassFeedback.findByPk(feedbackId, {
            include: [{
                model: Class,
                as: 'class',
                include: [{
                    model: Course,
                    as: 'course',
                    attributes: ['instructor_id']
                }]
            }]
        });

        if (!feedback) {
            return res.status(404).json({ message: '피드백을 찾을 수 없습니다.' });
        }

        // 권한 검증: 해당 수업의 강사인지
        if (!feedback.class || !feedback.class.course || feedback.class.course.instructor_id !== instructorId) {
            return res.status(403).json({ message: '이 피드백에 대한 공개 요청 권한이 없습니다.' });
        }

        // 요청한 이력이 있으면 재요청 불가
        if (feedback.is_publication_requested !== null) {
            return res.status(400).json({ message: '이미 요청하거나 완료한 피드백입니다.' });
        }


        // 상태 업데이트: 공개 요청
        feedback.is_publication_requested = true;
        feedback.publish_requested_at = new Date();
        feedback.publish_approved = false;   // 이전 학생 응답 상태 초기화
        feedback.publish_rejected = false;
        feedback.reject_reason = null;
        feedback.is_public = false;          // 학생 승인 전까지는 비공개

        await feedback.save();

        res.status(200).json({ message: '피드백 공개 요청을 성공적으로 보냈습니다.', feedback });

    } catch (err) {
        console.error('피드백 공개 요청 오류:', err);
        res.status(500).json({ message: '서버 오류로 피드백 공개 요청에 실패했습니다.' });
    }
};

/**
 * 강사가 피드백을 미공개로 확정합니다. (공개 요청을 하지 않기로 결정)
 */
exports.finalizeFeedbackAsNonPublic = async (req, res) => {
    const { feedbackId } = req.params;
    const instructorId = req.user.id;

    try {
        const feedback = await ClassFeedback.findByPk(feedbackId, {
            include: [{
                model: Class,
                as: 'class',
                include: [{
                    model: Course,
                    as: 'course',
                    attributes: ['instructor_id']
                }]
            }]
        });

        if (!feedback) {
            return res.status(404).json({ message: '피드백을 찾을 수 없습니다.' });
        }

        // 권한 검증: 해당 수업의 강사인지
        if (!feedback.class || !feedback.class.course || feedback.class.course.instructor_id !== instructorId) {
            return res.status(403).json({ message: '이 피드백의 상태를 변경할 권한이 없습니다.' });
        }

        // 요청한 이력이 있으면 재요청 불가
        if (feedback.is_publication_requested !== null) {
            return res.status(400).json({ message: '이미 요청하거나 완료한 피드백입니다.' });
        }

        // 상태 업데이트: 미공개로 확정
        feedback.is_publication_requested = false; // 명시적으로 요청 안 함 상태
        // publish_requested_at은 마지막 요청 시점을 기록으로 남길 수도 있고, null로 초기화할 수도 있습니다.
        // 여기서는 "미공개 확정"이므로, 이전 요청 기록은 의미가 없을 수 있어 null로 처리합니다.
        feedback.publish_requested_at = null;
        // 이미 진행 중이던 요청에 대한 학생의 응답도 의미가 없어지므로 초기화
        feedback.publish_approved = false;
        feedback.publish_rejected = false;
        feedback.reject_reason = null;
        feedback.is_public = false;

        await feedback.save();

        res.status(200).json({ message: '피드백을 미공개로 확정했습니다.', feedback });

    } catch (err) {
        console.error('피드백 미공개 확정 오류:', err);
        res.status(500).json({ message: '서버 오류로 피드백 상태 변경에 실패했습니다.' });
    }
};


exports.getCourseProgressWithStatus = async (req, res) => {
    const { courseId, studentId } = req.query;

    if (!courseId && !studentId) {
        return res.status(400).json({ message: 'courseId 또는 studentId 중 하나는 반드시 전달되어야 합니다.' });
    }

    try {

        if (courseId && studentId) {
            // 시나리오 1: courseId와 studentId 모두 제공 (특정 학생의 특정 과정 진행 현황)

            // 1. 해당 과정의 모든 수료 기준 가져오기
            criteriaResponse = await CourseCompletionCriteria.findAll({
                where: { course_id: courseId },
                attributes: ['id', 'course_id', 'type', 'value', 'description', 'sort_order'],
                order: [['sort_order', 'ASC'], ['id', 'ASC']],
                raw: true,
            });

            // 2. 해당 학생의 해당 과정 기준들에 대한 통과 기록 가져오기
            if (criteriaResponse.length > 0) {
                const criteriaIds = criteriaResponse.map(c => c.id);
                const progressRecords = await StudentCourseProgress.findAll({
                    where: {
                        user_id: studentId,
                        criterion_id: { [Op.in]: criteriaIds }
                    },
                    attributes: ['user_id', 'criterion_id', 'class_id', 'notes', 'created_at'],
                    include: [
                        { model: User, as: 'user', attributes: ['id', 'name'] },
                        { model: Class, as: 'classWherePassed', attributes: ['id', 'title'] }
                    ],
                    raw: true, // include된 객체도 plain object로 받기 위해선 별도 처리 필요 또는 map에서 .get()
                });
                // raw:true 사용 시 include된 객체는 prog['user.name'] 등으로 접근해야 함.
                // 여기서는 map에서 prog.user?.name을 사용하므로 findAll에서 raw:true를 빼고 아래에서 .get() 사용
            }
            // progressRecords를 가져오는 부분을 criteriaResponse.length > 0 안으로 옮김
            const criteriaIds = criteriaResponse.map(c => c.id);
            const progressRecordsRaw = await StudentCourseProgress.findAll({
                where: {
                    user_id: studentId,
                    criterion_id: { [Op.in]: criteriaIds }
                },
                attributes: ['user_id', 'criterion_id', 'class_id', 'notes', 'created_at'],
                include: [
                    { model: User, as: 'user', attributes: ['id', 'name'] },
                    { model: Class, as: 'classWherePassed', attributes: ['id', 'title'] }
                ],
            });

            studentProgressResponse = progressRecordsRaw.map(pInstance => {
                const prog = pInstance.get({ plain: true });
                const criterionDetail = criteriaResponse.find(c => c.id === prog.criterion_id);
                return {
                    studentId: prog.user_id,
                    studentName: prog.user?.name || null,
                    criterionId: prog.criterion_id,
                    courseId: criterionDetail?.course_id || courseId,
                    criterionType: criterionDetail?.type || null,
                    criterionValue: criterionDetail?.value || null,
                    classId: prog.class_id,
                    className: prog.classWherePassed?.title || null,
                    passed_at: prog.created_at,
                    notes: prog.notes || null
                };
            });


        } else if (courseId) {
            // 시나리오 2: courseId만 제공 (해당 과정의 모든 학생 진행 현황)

            // 1. 해당 과정의 모든 수료 기준 가져오기
            criteriaResponse = await CourseCompletionCriteria.findAll({
                where: { course_id: courseId },
                attributes: ['id', 'course_id', 'type', 'value', 'description', 'sort_order'],
                order: [['sort_order', 'ASC'], ['id', 'ASC']],
                raw: true,
            });

            // 2. 해당 과정 기준들에 대한 모든 학생의 통과 기록 가져오기
            if (criteriaResponse.length > 0) {
                const criteriaIds = criteriaResponse.map(c => c.id);
                const progressRecordsRaw = await StudentCourseProgress.findAll({
                    where: {
                        criterion_id: { [Op.in]: criteriaIds }
                    },
                    attributes: ['user_id', 'criterion_id', 'class_id', 'notes', 'created_at'],
                    include: [
                        { model: User, as: 'user', attributes: ['id', 'name'] },
                        { model: Class, as: 'classWherePassed', attributes: ['id', 'title'] }
                    ],
                    order: [['user_id', 'ASC'], ['criterion_id', 'ASC']],
                });

                studentProgressResponse = progressRecordsRaw.map(pInstance => {
                    const prog = pInstance.get({ plain: true });
                    const criterionDetail = criteriaResponse.find(c => c.id === prog.criterion_id);
                    return {
                        studentId: prog.user_id,
                        studentName: prog.user?.name || null,
                        criterionId: prog.criterion_id,
                        courseId: criterionDetail?.course_id || courseId,
                        criterionType: criterionDetail?.type || null,
                        criterionValue: criterionDetail?.value || null,
                        classId: prog.class_id,
                        className: prog.classWherePassed?.title || null,
                        passed_at: prog.created_at,
                        notes: prog.notes || null
                    };
                });
            }

        } else if (studentId) {
            // 시나리오 3: studentId만 제공 (해당 학생의 모든 과정에 대한 모든 통과 현황)

            // 1. 해당 학생의 모든 통과 기록(StudentCourseProgress) 가져오기
            const progressRecordsRaw = await StudentCourseProgress.findAll({
                where: { user_id: studentId },
                attributes: ['user_id', 'criterion_id', 'class_id', 'notes', 'created_at'],
                include: [
                    { model: User, as: 'user', attributes: ['id', 'name'] },
                    { model: Class, as: 'classWherePassed', attributes: ['id', 'title'] }
                ],
                // 과정별, 기준별 정렬을 위해 CourseCompletionCriteria를 통해 Course 정보도 가져오면 좋음
                // 여기서는 일단 criterion_id로 정렬
                order: [
                    // [sequelize.literal('`criterion.course.id`'), 'ASC'], // 예시: 만약 criterion을 include 했다면
                    ['criterion_id', 'ASC'] // 또는 created_at 등
                ],
            });

            // 2. 통과한 모든 criterion_id에 해당하는 CourseCompletionCriteria 정보 가져오기
            if (progressRecordsRaw.length > 0) {
                const distinctCriterionIds = [...new Set(progressRecordsRaw.map(p => p.get('criterion_id')))];

                const criteriaDetailsForStudent = await CourseCompletionCriteria.findAll({
                    where: { id: { [Op.in]: distinctCriterionIds } },
                    attributes: ['id', 'course_id', 'type', 'value', 'description', 'sort_order'],
                    order: [['course_id', 'ASC'], ['sort_order', 'ASC'], ['id', 'ASC']],
                    raw: true,
                });
                criteriaResponse = criteriaDetailsForStudent; // 학생이 통과한 기준들의 정의 목록

                const criteriaDetailMap = new Map(criteriaDetailsForStudent.map(c => [c.id, c]));

                studentProgressResponse = progressRecordsRaw.map(pInstance => {
                    const prog = pInstance.get({ plain: true });
                    const criterionDetail = criteriaDetailMap.get(prog.criterion_id);
                    return {
                        studentId: prog.user_id,
                        studentName: prog.user?.name || null,
                        criterionId: prog.criterion_id,
                        courseId: criterionDetail?.course_id || null, // 기준으로부터 courseId 추출
                        criterionType: criterionDetail?.type || null,
                        criterionValue: criterionDetail?.value || null,
                        classId: prog.class_id,
                        className: prog.classWherePassed?.title || null,
                        passed_at: prog.created_at,
                        notes: prog.notes || null
                    };
                });
            }
        }

        res.status(200).json({
            criteria: criteriaResponse,
            studentProgress: studentProgressResponse
        });

    } catch (err) {
        console.error('수료 기준 통과 현황 조회 오류:', err);
        res.status(500).json({ message: '서버 오류로 조회에 실패했습니다.' });
    }
};

exports.getClassById = async (req, res) => {
    const { classId } = req.params;

    try {
        const targetClass = await Class.findByPk(classId, {
            attributes: ['id', 'title', 'start_datetime', 'end_datetime', 'course_id' /*, 기타 필요한 Class 정보 */],
            include: [ // 필요하다면 Course 정보 등도 함께 JOIN 해서 반환 가능
                {
                    model: Course,
                    as: 'course',
                    attributes: ['id', 'title', 'instructor_id'], // course_id는 Class 모델에 이미 있으므로, 여기선 title 등 부가 정보
                    // include: [{ model: Instructor, as: 'instructor', attributes: ['name']}] // 강사 이름도 필요하면
                }
            ]
        });

        if (!targetClass) {
            return res.status(404).json({ message: '수업을 찾을 수 없습니다.' });
        }

        // TODO: 권한 검증 로직 추가 가능
        // 예를 들어, 로그인한 사용자가 이 수업 정보를 볼 권한이 있는지 (예: 강사이거나 수강생)
        // const requestingUser = req.user;
        // if (requestingUser.userType === 'instructor' && targetClass.course?.instructor_id !== requestingUser.id) {
        //     // 본인 수업이 아니면 접근 제한 (정책에 따라)
        // }

        res.status(200).json(targetClass);

    } catch (err) {
        console.error('수업 상세 조회 오류:', err);
        res.status(500).json({ message: '서버 오류로 수업 조회에 실패했습니다.' });
    }
};