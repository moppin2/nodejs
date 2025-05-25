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
    } = req.body;

    const instructorId = req.user.id; // 현재 로그인한 강사 ID (authMiddleware를 통해 설정됨)
    const now = new Date();

    try {
        // 1. 필수 값 검증
        if (!class_id || !user_id || !feedback_text) {
            return res.status(400).json({ message: '수업 ID, 학생 ID, 피드백 내용은 필수입니다.' });
        }
        if (!rating) { // 평점도 필수라고 가정
            return res.status(400).json({ message: '평점은 필수입니다.' });
        }


        // 2. 권한 검증: 요청한 강사가 해당 수업의 실제 강사인지 확인
        const targetClass = await Class.findByPk(class_id, {
            include: [{
                model: Course,
                as: 'course', // Class 모델과 Course 모델 간의 관계 설정 alias
                attributes: ['instructor_id']
            }]
        });

        if (!targetClass) {
            return res.status(404).json({ message: '수업을 찾을 수 없습니다.' });
        }

        if (targetClass.course.instructor_id !== instructorId) {
            return res.status(403).json({ message: '해당 수업의 강사만 피드백을 작성할 수 있습니다.' });
        }

        if (targetClass.end_datetime > now) {
            return res.status(403).json({ message: '수업 종료 후 피드백 작성 가능합니다.' });
        }

        // 3. 해당 학생(user_id)이 실제로 해당 수업(class_id)에 등록/참여했는지 검증 로직
        const reservation = await ClassReservation.findOne({ where: { class_id, user_id, status: { [Op.in]: ['approved', 'applied', 'cancel_request'] } } });
        if (!reservation) {
            return res.status(403).json({ message: '예약하지 않았거나 예약확정이 되지 않은 수강생 입니다.' });
        }

        // 4. 중복 피드백 방지 (DB unique 제약조건이 있지만, API 레벨에서도 한번 더 확인 가능)
        // ClassFeedback 모델에 (class_id, user_id) unique 제약조건이 설정되어 있다고 가정
        const existingFeedback = await ClassFeedback.findOne({
            where: { class_id: Number(class_id), user_id: Number(user_id) }
        });
        if (existingFeedback) {
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
        });

        // 6. 업로드된 파일 정보(UploadFile)의 target_id를 새로 생성된 feedback.id로 업데이트
        if (file_keys && file_keys.length > 0) {
            await UploadFile.update(
                {
                    target_id: newFeedback.id,
                    target_type: 'feedback' // target_type을 명시적으로 'feedback'으로 설정
                },
                {
                    where: {
                        file_key: { [Op.in]: file_keys },
                        // 추가 조건: 아직 target_id가 할당되지 않은 파일들만 대상으로 하거나,
                        // 또는 이전에 임시 target_type/target_id로 저장된 파일들을 대상으로 할 수 있음
                        // target_id: null // 만약 /api/upload/record에서 target_id 없이 저장했다면
                    }
                }
            );
        }

        res.status(201).json({
            message: '피드백이 성공적으로 생성되었습니다.',
            feedbackId: newFeedback.id, // 생성된 피드백 ID 반환
            feedback: newFeedback     // 생성된 피드백 객체 전체 반환 (선택)
        });

    } catch (err) {
        console.error('피드백 생성 오류:', err);
        // Sequelize의 UniqueConstraintError 처리 (class_id, user_id 중복 시)
        if (err.name === 'SequelizeUniqueConstraintError') {
            return res.status(409).json({ message: '이미 해당 학생에 대한 이 수업의 피드백이 존재합니다. 수정을 이용해주세요.' });
        }
        res.status(500).json({ message: '서버 오류로 인해 피드백 생성에 실패했습니다.' });
    }
};

exports.updateFeedback = async (req, res) => {
    const { feedbackId } = req.params; // 라우트 파라미터에서 feedbackId 가져오기
    const {
        feedback_text,
        rating,
        file_keys = [],         // 최종적으로 이 피드백에 연결될 파일들의 key 목록
    } = req.body;
    const instructorId = req.user.id;

    try {
        // 1. 피드백 존재 여부 확인
        const feedback = await ClassFeedback.findByPk(feedbackId, {
            include: [{ // 피드백이 속한 수업 및 과정 정보를 가져와 강사 확인
                model: Class,
                as: 'class', // ClassFeedback 모델과 Class 모델 간의 관계 alias
                include: [{
                    model: Course,
                    as: 'course', // Class 모델과 Course 모델 간의 관계 alias
                    attributes: ['instructor_id']
                }]
            }]
        });

        if (!feedback) {
            return res.status(404).json({ message: '피드백을 찾을 수 없습니다.' });
        }

        // 2. 권한 검증: 요청한 강사가 해당 피드백이 속한 수업의 실제 강사인지 확인
        if (!feedback.class || !feedback.class.course || feedback.class.course.instructor_id !== instructorId) {
            return res.status(403).json({ message: '해당 피드백을 수정할 권한이 없습니다.' });
        }

        // 3. 피드백 수정 가능 상태 검증 (중요!)
        // 예: is_publication_requested가 null (임시저장)인 경우에만 수정 가능
        const isEditable = feedback.is_publication_requested === null;
        if (!isEditable) {
            return res.status(403).json({ message: '현재 상태에서는 피드백을 수정할 수 없습니다.' });
        }

        // 4. 피드백 내용 업데이트
        feedback.feedback_text = feedback_text;
        feedback.rating = Number(rating);
        feedback.is_publication_requested = null;
        feedback.publish_requested_at = null;
        feedback.publish_approved = false;
        feedback.publish_rejected = false;
        feedback.reject_reason = null;
        feedback.is_public = false;

        await feedback.save();

        // 5. 파일 연결 업데이트 (Course 수정 로직 참고)
        // 5a. 기존에 이 피드백(target_id)에 연결되어 있던 'feedback' 타입의 파일들의 연결을 모두 해제 (target_id: null)
        await UploadFile.update(
            { target_id: null },
            {
                where: {
                    target_type: 'feedback',
                    target_id: feedback.id
                }
            }
        );

        // 5b. 요청 바디에 포함된 새로운 file_keys들을 현재 feedback.id에 연결
        if (file_keys && file_keys.length > 0) {
            await UploadFile.update(
                {
                    target_id: feedback.id,
                    target_type: 'feedback' // 명시적으로 다시 설정
                },
                {
                    where: {
                        file_key: { [Op.in]: file_keys }
                        // 이 file_key들은 이미 UploadFile 테이블에 존재해야 하며,
                        // 이전 단계(Presigned URL 발급 및 /api/upload/record)에서 target_id가 없거나 임시값으로 저장되었을 수 있음
                    }
                }
            );
        }

        res.status(200).json({
            message: '피드백이 성공적으로 수정되었습니다.',
            feedback: feedback
        });

    } catch (err) {
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
        feedback.is_public = false; // 미공개 확정이므로 당연히 비공개

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
        let courseCriteriaList = [];
        let progressRecords = [];

        if (courseId) {
            // 1. 해당 courseId의 모든 수료 기준(CourseCompletionCriteria)을 가져옵니다.
            courseCriteriaList = await CourseCompletionCriteria.findAll({
                where: { course_id: courseId },
                attributes: ['id', 'course_id', 'type', 'value', 'description', 'sort_order'],
                order: [['sort_order', 'ASC'], ['id', 'ASC']],
                // raw: true, // .get({ plain: true })를 사용할 것이므로 raw: true는 선택적
            });

            if (!courseCriteriaList.length) {
                // 과정에 기준이 없으면 빈 결과 반환
                return res.json({ criteria: [], studentProgress: [] });
            }

            const criteriaIds = courseCriteriaList.map(c => c.id);

            // 2. StudentCourseProgress 조회 조건 설정
            const progressWhereClause = {
                criterion_id: { [Op.in]: criteriaIds },
            };
            if (studentId) {
                progressWhereClause.user_id = studentId;
            }

            progressRecords = await StudentCourseProgress.findAll({
                where: progressWhereClause,
                attributes: ['user_id', 'criterion_id', 'class_id', 'notes', 'created_at'],
                include: [
                    { model: User, as: 'user', attributes: ['id', 'name'] },
                    { model: Class, as: 'classWherePassed', attributes: ['id', 'title'] }
                ],
                order: studentId ? [['criterion_id', 'ASC']] : [['user_id', 'ASC'], ['criterion_id', 'ASC']],
            });

            // Sequelize 인스턴스를 plain object로 변환
            courseCriteriaList = courseCriteriaList.map(c => c.get({ plain: true }));
            progressRecords = progressRecords.map(p => p.get({ plain: true }));


        } else if (studentId) {
            // 3. studentId만 제공된 경우: 해당 학생의 모든 StudentCourseProgress 기록을 가져옵니다.
            progressRecords = await StudentCourseProgress.findAll({
                where: { user_id: studentId },
                attributes: ['user_id', 'criterion_id', 'class_id', 'notes', 'created_at'],
                include: [
                    { model: User, as: 'user', attributes: ['id', 'name'] },
                    { model: Class, as: 'classWherePassed', attributes: ['id', 'title'] }
                ],
                order: [['criterion_id', 'ASC']], // 또는 course_id, criterion_id 순 정렬 위해 Course 정보 join 필요
            });

            progressRecords = progressRecords.map(p => p.get({ plain: true }));

            // 이 경우, 각 progressRecord에 해당하는 CourseCompletionCriteria 정보와 courseId를 추가로 가져와야 합니다.
            if (progressRecords.length > 0) {
                const distinctCriterionIds = [...new Set(progressRecords.map(p => p.criterion_id))];
                const criteriaDetails = await CourseCompletionCriteria.findAll({
                    where: { id: { [Op.in]: distinctCriterionIds } },
                    attributes: ['id', 'course_id', 'type', 'value', 'description', 'sort_order'],
                    raw: true,
                });
                const criteriaDetailMap = new Map(criteriaDetails.map(c => [c.id, c]));

                // courseCriteriaList를 채워서 아래 최종 결과 가공 시 사용 (또는 progressRecords에 직접 병합)
                courseCriteriaList = criteriaDetails; // 이 API 응답의 'criteria' 부분에 사용될 수 있음 (중복될 수 있음)

                // progressRecords에 criterion 상세 정보와 courseId를 병합 (결과 형식을 통일하기 위함)
                progressRecords.forEach(prog => {
                    const critDetail = criteriaDetailMap.get(prog.criterion_id);
                    prog.criterion_type = critDetail?.type;
                    prog.criterion_value = critDetail?.value;
                    prog.course_id_from_criterion = critDetail?.course_id; // courseId 정보 추가
                });
            }
        }

        // 최종 결과 가공 (courseId가 제공되었을 때의 studentProgress 형식과 유사하게 맞춤)
        const finalStudentProgress = progressRecords.map(prog => ({
            studentId: prog.user_id,
            studentName: prog.user?.name || null,
            criterionId: prog.criterion_id,
            // courseId가 제공되었을 때는 criteriaList에서 가져오고, studentId만 있을때는 prog에 병합된 정보 사용
            // 이 부분은 프론트에서 criteria 리스트와 매칭하거나, 아래처럼 API에서 제공할 수 있음
            // type: (criteriaMap.get(prog.criterion_id))?.type, (courseId 있을때)
            // value: (criteriaMap.get(prog.criterion_id))?.value, (courseId 있을때)
            classId: prog.class_id,
            className: prog.classWherePassed?.title || null,
            passed_at: prog.created_at,
            notes: prog.notes || null,
            // studentId만 제공된 경우를 위해, 각 progress 항목에 courseId와 criterion 상세 정보를 포함시키는 것이 좋음
            courseId: prog.course_id_from_criterion || (courseId ? parseInt(courseId) : null),
            criterionType: prog.criterion_type || (criteriaMap.get(prog.criterion_id))?.type,
            criterionValue: prog.criterion_value || (criteriaMap.get(prog.criterion_id))?.value
        }));


        res.status(200).json({
            criteria: courseId ? courseCriteriaList : (studentId && courseCriteriaList.length > 0 ? courseCriteriaList : []), // courseId가 있을 때만 의미있는 criteria 목록, 또는 studentId 조회시 관련된 criteria
            studentProgress: finalStudentProgress
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