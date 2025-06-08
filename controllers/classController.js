const { Class, Course, Instructor, License, ClassReservation, CourseCompletionCriteria, StudentCourseProgress,
    UploadFile, User, ClassFeedback, ClassReview, CourseApplication, ClassReservationHistory,
    ChatRoom, ChatRoomParticipant, ChatMessage, sequelize, Sequelize } = require('../models');
const { Op, fn, col } = require('sequelize');
const s3Service = require('../services/s3Service');

exports.upsertClass = async (req, res) => {
    const t = await sequelize.transaction(); // 트랜잭션 사용
    try {
        const data = req.body;
        const instructorId = req.user.id; // 로그인된 강사 ID

        // 1) 과정 소유권 검증 (없으면 403)
        const course = await Course.findOne({
            where: { id: data.course_id, instructor_id: instructorId },
            transaction: t,
        });
        if (!course) {
            await t.rollback();
            return res.status(403).json({ error: '해당 과정에 대한 권한이 없습니다.' });
        }

        // 1.5) 일시 순서 검증: 종료 ≤ 시작인 경우 에러
        if (data.start_datetime && data.end_datetime) {
            const start = new Date(data.start_datetime);
            const end = new Date(data.end_datetime);
            if (end <= start) {
                await t.rollback();
                return res.status(400).json({ error: '종료 일시는 시작 일시보다 이후여야 합니다.' });
            }
        }

        let cls;

        // 2) 수정 모드
        if (data.id) {
            cls = await Class.findOne({
                where: { id: data.id, course_id: data.course_id },
                transaction: t,
            });
            if (!cls) {
                await t.rollback();
                return res.status(404).json({ error: '수업을 찾을 수 없습니다.' });
            }
            await cls.update(data, { transaction: t });
            await t.commit();
            return res.json(cls);
        }

        // 3) 생성 모드
        cls = await Class.create(data, { transaction: t });

        // 3.1) 채팅방 생성
        const chatRoom = await ChatRoom.create({
            room_type: 'class',
            related_class_id: cls.id,
            title: `${course.title} - ${cls.title || '수업'} 채팅방`,
        }, { transaction: t });

        // 3.2) 강사를 참가자로 등록
        await ChatRoomParticipant.create({
            chat_room_id: chatRoom.id,
            user_type: 'instructor',
            user_id: instructorId,
        }, { transaction: t });

        await t.commit();
        return res.json(cls);

    } catch (err) {
        if (t) await t.rollback();
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
        const { classId: classIdFromParams } = req.params;

        let whereClause = {};

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
            whereClause = {
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


        if (classIdFromParams) {
            whereClause.id = classIdFromParams; // Class 모델의 기본키가 'id'라고 가정
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
            const studentFeedbackMap = {}, studentReviewMap = {};;
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

                const reviewAttributes = [
                    'id', 'class_id', 'user_id', 'is_public'
                ];
                (await ClassReview.findAll({
                    where: { class_id: { [Op.in]: classIds } }, //////////////////////////////where 맞는지 확인 필요
                    attributes: reviewAttributes
                })).forEach(rvInstance => { // rvInstance로 변경
                    // 각 class_id 와 user_id 조합을 키로 사용하여 피드백 객체 저장
                    studentReviewMap[`c${rvInstance.class_id}_u${rvInstance.user_id}`] = rvInstance.get({ plain: true });
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
                const currentStudentReview = studentReviewMap[`c${r.class_id}_u${r.user_id}`] || null;
                reservationListMap[r.class_id].push({
                    id: r.id,
                    status: effectiveStatus,
                    user: {
                        id: r.user.id,
                        name: r.user.name,
                        userType: 'user',
                        avatarUrl: studentAvatarMap[r.user.id] || null
                    },
                    feedback: currentStudentFeedback,
                    review: currentStudentReview
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
                location: c.location,
                capacity: c.capacity,
                description: c.description,
                materials: c.materials,
                additional_fees: c.additional_fees,
                is_reservation_closed: c.is_reservation_closed,
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

exports.getClassDetail = async (req, res) => {
    const { classId } = req.params;
    const now = new Date();

    try {
        // 1. 기본 수업 정보 및 관련 과정, 강사, 라이선스 정보 조회
        const targetClass = await Class.findByPk(classId, {
            include: [{
                model: Course,
                as: 'course',
                attributes: ['id', 'title', 'license_id', 'instructor_id'],
                include: [
                    { model: Instructor, as: 'instructor', attributes: ['id', 'name'] },
                    { model: License, as: 'license', attributes: ['association', 'name'] }
                ],
                required: true
            }],
        });

        if (!targetClass) {
            return res.status(404).json({ message: '수업을 찾을 수 없습니다.' });
        }

        // 3. 후처리 데이터 준비
        // 3a. 예약 건수
        const reservationCounts = await ClassReservation.findAll({
            attributes: ['status', [fn('COUNT', col('id')), 'count']],
            where: { class_id: targetClass.id, status: { [Op.in]: ['applied', 'approved', 'cancel_request'] } },
            group: ['status'], raw: true
        });
        const currentClassCountMap = {};
        reservationCounts.forEach(r => { currentClassCountMap[r.status] = parseInt(r.count, 10); });
        const totalReserved = ['applied', 'approved', 'cancel_request']
            .reduce((sum, s) => sum + (currentClassCountMap[s] || 0), 0);

        // 3b. 강사 아바타
        let instructorAvatarUrl = null;
        if (targetClass.course.instructor_id) {
            const instructorAvatarFile = await UploadFile.findOne({
                where: { target_type: 'instructor', target_id: targetClass.course.instructor_id, purpose: 'profile', is_public: true }
            });
            const bucket = process.env.UPLOAD_BUCKET;
            if (instructorAvatarFile) {
                instructorAvatarUrl = `https://${bucket}.s3.amazonaws.com/${instructorAvatarFile.file_key}`;
            }
        }

        // 3c. 수업 상태
        let classStatus;
        const classStartDate = new Date(targetClass.start_datetime);
        const classEndDate = new Date(targetClass.end_datetime);
        if (now < classStartDate) {
            classStatus = totalReserved < targetClass.capacity ? 'reserved_open' : 'reserved_closed';
        } else if (now <= classEndDate) {
            classStatus = 'in_progress';
        } else {
            classStatus = 'completed';
        }

        // 3d. 이 수업의 모든 예약 정보
        const allReservationsForThisClass = await ClassReservation.findAll({
            where: { class_id: targetClass.id },
            include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
            order: [['created_at', 'ASC']]
        });

        const studentIdsInClass = allReservationsForThisClass.map(r => r.user_id).filter(id => id != null);
        const studentFeedbackMap = {};
        const studentReviewMap = {};
        const publicFeedbackIds = [];
        const publicReviewIds = [];

        if (studentIdsInClass.length > 0) {
            const feedbackAttributes = [ /* ... (이전과 동일한 필드 목록) ... */
                'id', 'feedback_text', 'rating', 'is_public', 'class_id', 'user_id',
                'is_publication_requested', 'publish_requested_at',
                'publish_approved', 'publish_approved_at',
                'publish_rejected', 'publish_rejected_at', 'reject_reason'
            ];
            const allFeedbacksForStudents = await ClassFeedback.findAll({
                where: { class_id: targetClass.id, user_id: { [Op.in]: studentIdsInClass } },
                attributes: feedbackAttributes
            });
            allFeedbacksForStudents.forEach(fb => {
                const feedbackData = fb.get({ plain: true });
                studentFeedbackMap[`u${fb.user_id}`] = feedbackData;
                if (feedbackData.is_public) {
                    publicFeedbackIds.push(feedbackData.id);
                }
            });

            const reviewAttributes = ['id', 'class_id', 'user_id', 'rating', 'review_text', 'is_public'];
            const allReviewsForStudents = await ClassReview.findAll({
                where: { class_id: targetClass.id, user_id: { [Op.in]: studentIdsInClass } },
                attributes: reviewAttributes
            });
            allReviewsForStudents.forEach(rv => {
                const reviewData = rv.get({ plain: true });
                studentReviewMap[`u${rv.user_id}`] = reviewData;
                if (reviewData.is_public) {
                    publicReviewIds.push(reviewData.id);
                }
            });
        }

        // 3e. 공개된 피드백/리뷰의 이미지들만 URL 생성
        const feedbackImageMap = {};
        const reviewImageMap = {};
        const bucket = process.env.UPLOAD_BUCKET; // .env 등에서 설정

        if (publicFeedbackIds.length > 0) {
            const feedbackImages = await UploadFile.findAll({
                where: { target_type: 'feedback', target_id: { [Op.in]: publicFeedbackIds } },
                attributes: ['id', 'file_key', 'file_name', 'target_id']
            });
            for (const img of feedbackImages) {
                if (!feedbackImageMap[img.target_id]) feedbackImageMap[img.target_id] = [];
                try {
                    const url = await s3Service.generatePresignedGetUrl(img.file_key, 3600);
                    feedbackImageMap[img.target_id].push({ id: img.id, file_key: img.file_key, name: img.file_name, url });
                } catch (e) { console.error(e); }
            }
        }
        if (publicReviewIds.length > 0) {
            const reviewImages = await UploadFile.findAll({
                where: { target_type: 'review', target_id: { [Op.in]: publicReviewIds } },
                attributes: ['id', 'file_key', 'file_name', 'target_id']
            });
            for (const img of reviewImages) {
                if (!reviewImageMap[img.target_id]) reviewImageMap[img.target_id] = [];
                try {
                    const url = await s3Service.generatePresignedGetUrl(img.file_key);
                    reviewImageMap[img.target_id].push({ id: img.id, file_key: img.file_key, name: img.file_name, url });
                } catch (e) { console.error(e); }
            }
        }

        // 학생 아바타 (기존 로직)
        const studentAvatarMap = {};
        if (studentIdsInClass.length > 0) {
            const studentAvatarFiles = await UploadFile.findAll({
                where: { target_type: 'user', target_id: { [Op.in]: studentIdsInClass }, purpose: 'profile', is_public: true }
            });
            studentAvatarFiles.forEach(f => { studentAvatarMap[f.target_id] = `https://${bucket}.s3.amazonaws.com/${f.file_key}`; });
        }

        // 예약 목록 상세 구성
        const reservationsDetails = allReservationsForThisClass.map(rInstance => {
            const r = rInstance.get({ plain: true });
            let effectiveStatus = r.status;
            if (now >= classStartDate) {
                if (r.status === 'applied') effectiveStatus = 'approved';
                if (r.status === 'cancel_request') effectiveStatus = 'approved';
            }

            let processedFeedback = null;
            const originalFeedback = studentFeedbackMap[`u${r.user_id}`];
            if (originalFeedback) {
                if (originalFeedback.is_public) {
                    processedFeedback = { ...originalFeedback, images: feedbackImageMap[originalFeedback.id] || [] };
                } else { // 비공개 피드백: 상태 정보만
                    processedFeedback = {
                        id: originalFeedback.id,
                        class_id: originalFeedback.class_id,
                        user_id: originalFeedback.user_id,
                        is_public: false,
                        is_publication_requested: originalFeedback.is_publication_requested,
                        publish_requested_at: originalFeedback.publish_requested_at,
                        publish_approved: originalFeedback.publish_approved,
                        publish_approved_at: originalFeedback.publish_approved_at,
                        publish_rejected: originalFeedback.publish_rejected,
                        publish_rejected_at: originalFeedback.publish_rejected_at,
                        reject_reason: originalFeedback.reject_reason,
                        // feedback_text, rating 등은 제외
                        images: []
                    };
                }
            }

            let processedReview = null;
            const originalReview = studentReviewMap[`u${r.user_id}`];
            if (originalReview) {
                if (originalReview.is_public) {
                    processedReview = { ...originalReview, images: reviewImageMap[originalReview.id] || [] };
                } else { // 비공개 리뷰: id와 is_public만
                    processedReview = {
                        id: originalReview.id,
                        is_public: false,
                        // review_text, rating 등은 제외
                        images: []
                    };
                }
            }

            return {
                id: r.id,
                status: effectiveStatus,
                user: r.user ? {
                    id: r.user.id, name: r.user.name, userType: 'user',
                    avatarUrl: studentAvatarMap[r.user.id] || null
                } : null,
                feedback: processedFeedback,
                review: processedReview
            };
        });

        // 4. 최종 결과 객체 조립
        const result = {
            id: targetClass.id,
            title: targetClass.title,
            start_datetime: targetClass.start_datetime,
            end_datetime: targetClass.end_datetime,
            capacity: targetClass.capacity,
            description: targetClass.description,
            location: targetClass.location,
            materials: targetClass.materials,
            additional_fees: targetClass.additional_fees,
            is_reservation_closed: targetClass.is_reservation_closed,
            course_id: targetClass.course.id,
            course_title: targetClass.course.title,
            instructor: {
                id: targetClass.course.instructor_id,
                name: targetClass.course.instructor?.name || '',
                userType: 'instructor',
                avatarUrl: instructorAvatarUrl
            },
            license_association: targetClass.course.license?.association || '',
            license_name: targetClass.course.license?.name || '',
            reserved_count: totalReserved,
            status: classStatus,
            reservations: reservationsDetails
        };

        res.status(200).json(result);

    } catch (err) {
        console.error(`수업 상세(강사용) 조회 오류 (Class ID: ${classId}):`, err);
        res.status(500).json({ message: '서버 오류로 수업 상세 정보 조회에 실패했습니다.' });
    }
};

exports.createReservation = async (req, res) => {
    const t = await sequelize.transaction();
    try {
        const userId = req.user.id;
        const { class_id } = req.body;

        // 1) 해당 Class 존재 여부 확인
        const cls = await Class.findByPk(class_id, { transaction: t });
        if (!cls) {
            await t.rollback();
            return res.status(404).json({ message: '해당 수업을 찾을 수 없습니다.' });
        }

        // 2) 예약 마감 여부 및 시작 시간 확인
        if (new Date() >= cls.start_datetime || cls.is_reservation_closed === true) {
            await t.rollback();
            return res.status(400).json({ message: '예약 마감 이후에는 예약 할 수 없습니다.' });
        }

        // 3) “정원 초과” 체크
        const totalRequests = await ClassReservation.count({
            where: {
                class_id,
                status: { [Op.in]: ['applied', 'approved', 'cancel_request'] }
            },
            transaction: t,
        });
        if (totalRequests >= cls.capacity) {
            await t.rollback();
            return res.status(400).json({ message: '예약 정원이 가득 찼습니다.' });
        }

        // 4) 사용자가 해당 Course에 승인된 상태인지 확인
        const hasCourse = await CourseApplication.findOne({
            where: {
                course_id: cls.course_id,
                user_id: userId,
                status: 'approved'
            },
            transaction: t,
        });
        if (!hasCourse) {
            await t.rollback();
            return res.status(403).json({ message: '수강중인 과정의 수업만 예약할 수 있습니다.' });
        }

        // 5) 기존 예약 조회
        let reservation = await ClassReservation.findOne({
            where: { class_id, user_id: userId },
            transaction: t,
        });

        if (reservation) {
            // 이미 존재하는 예약이 있고, 거절 또는 취소 상태였다면 다시 신청으로 전환
            if (['rejected', 'cancelled'].includes(reservation.status)) {
                reservation.status = 'applied';
                await reservation.save({ transaction: t });
            } else {
                await t.rollback();
                return res.status(400).json({ message: '이미 예약 상태입니다.' });
            }
        } else {
            // 6) 신규 예약 생성
            reservation = await ClassReservation.create({
                class_id,
                user_id: userId
            }, { transaction: t });
        }

        // 7) 예약 이력 기록
        await ClassReservationHistory.create({
            reservation_id: reservation.id,
            action: 'apply',
            performed_by: userId,
            performer_type: 'user',
            reason: null
        }, { transaction: t });

        // 8) 채팅방 참가자 자동 등록
        //    - 클래스가 생성될 때 ChatRoom이 이미 만들어진 상태라고 가정
        const chatRoom = await ChatRoom.findOne({
            where: { room_type: 'class', related_class_id: cls.id },
            transaction: t,
        });

        if (chatRoom) {
            await ChatRoomParticipant.findOrCreate({
                where: {
                    chat_room_id: chatRoom.id,
                    user_type: 'user',
                    user_id: userId
                },
                defaults: {
                    joined_at: new Date()
                },
                transaction: t,
            });
        }

        // 모든 작업 성공 시 커밋
        await t.commit();
        return res.status(201).json(reservation);

    } catch (err) {
        // 오류 시 롤백
        await t.rollback();
        console.error('createReservation error:', err);
        return res.status(500).json({ message: '서버 오류로 예약에 실패했습니다.' });
    }
};

exports.changeReservationStatus = async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const reservation = req.reservation;
    const { action } = req.body;
    const { id: performerId, userType: performerType } = req.user;

    const statusMap = {
      approve: 'approved',
      reject: 'rejected',
      cancel: 'cancelled',
      cancel_request: 'cancel_request',
      cancel_approve: 'cancelled',
      cancel_deny: 'approved',
    };

    const newStatus = statusMap[action];
    if (!newStatus) {
      await t.rollback();
      throw new Error(`알 수 없는 액션: ${action}`);
    }

    // 1) 상태 업데이트
    reservation.status = newStatus;
    await reservation.save({ transaction: t });

    // 2) 이력 기록
    await ClassReservationHistory.create({
      reservation_id: reservation.id,
      action,
      performed_by: performerId,
      performer_type: performerType,
      reason: req.body.reason || null,
    }, { transaction: t });

    // 3) 'rejected' 또는 'cancelled' 상태라면 채팅방에서 해당 학생(user) 제거
    if (newStatus === 'rejected' || newStatus === 'cancelled') {
      const classId = reservation.class_id;

      const chatRoom = await ChatRoom.findOne({
        where: { room_type: 'class', related_class_id: classId },
        transaction: t,
      });

      if (chatRoom) {
        await ChatRoomParticipant.destroy({
          where: {
            chat_room_id: chatRoom.id,
            user_type: 'user',
            user_id: reservation.user_id, // 거절되거나 취소된 학생 ID
          },
          transaction: t,
        });
      }
    }

    await t.commit();
    return res.json(reservation);

  } catch (err) {
    await t.rollback();
    console.error('changeReservationStatus error:', err);
    return res.status(500).json({ message: '서버 오류로 상태 변경에 실패했습니다.' });
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
            if (img.is_public === false) {
                try {
                    // S3 서비스 함수 호출
                    displayUrl = await s3Service.generatePresignedGetUrl(img.file_key);
                } catch (s3Error) {
                    console.error(`Error getting presigned URL for feedback image ${img.file_key} from s3Service:`, s3Error);
                    // URL 생성 실패 시 어떻게 처리할지 결정 (예: null 유지, 기본 이미지 URL 등)
                }

            } else { // Public 파일
                const bucket = process.env.UPLOAD_BUCKET;
                const region = process.env.AWS_REGION;
                displayUrl = `https://${bucket}.s3.${region}.amazonaws.com/${img.file_key}`;
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

exports.approveFeedbackPublication = async (req, res) => {
    const { feedbackId } = req.params;
    const studentUserId = req.user.id; // 현재 로그인한 학생의 ID

    const t = await ClassFeedback.sequelize.transaction(); // 트랜잭션 시작

    try {
        const feedback = await ClassFeedback.findByPk(feedbackId, { transaction: t });

        if (!feedback) {
            await t.rollback();
            return res.status(404).json({ message: '피드백을 찾을 수 없습니다.' });
        }

        // 1. 권한 검증: 이 피드백이 현재 로그인한 학생의 것인지 확인
        if (feedback.user_id !== studentUserId) {
            await t.rollback();
            return res.status(403).json({ message: '자신의 피드백에 대해서만 이 작업을 수행할 수 있습니다.' });
        }

        // 2. 상태 검증: 강사의 공개 요청이 있었고, 아직 승인/거절되지 않은 상태인지 확인
        if (feedback.is_publication_requested !== true) {
            await t.rollback();
            return res.status(400).json({ message: '강사의 공개 요청이 없었거나 이미 처리된 요청입니다.' });
        }
        if (feedback.publish_approved || feedback.publish_rejected) {
            await t.rollback();
            return res.status(400).json({ message: '이미 공개 승인 또는 거절 처리된 피드백입니다.' });
        }

        // 3. 피드백 상태 업데이트: 공개 승인
        feedback.publish_approved = true;
        feedback.publish_approved_at = new Date();
        feedback.is_public = true; // 최종적으로 공개 상태로 변경
        feedback.is_publication_requested = false; // 요청 상태는 '처리됨'으로 변경 (선택적, 정책에 따라 true 유지 가능)
        feedback.publish_rejected = false; // 혹시 모를 이전 거절 상태 초기화
        feedback.reject_reason = null;   // 거절 사유 초기화

        await feedback.save({ transaction: t });
        await t.commit(); // 모든 작업 성공 시 트랜잭션 커밋

        res.status(200).json({ message: '피드백 공개를 성공적으로 승인했습니다.', feedback });

    } catch (err) {
        if (t && !t.finished) { // 트랜잭션이 아직 완료되지 않았다면 롤백
            try { await t.rollback(); } catch (rbError) { console.error('Rollback error on approving feedback publication:', rbError); }
        }
        console.error('피드백 공개 승인 오류:', err);
        res.status(500).json({ message: '서버 오류로 인해 피드백 공개 승인에 실패했습니다.' });
    }
};

/**
 * 학생이 피드백 공개를 거절합니다.
 */
exports.rejectFeedbackPublication = async (req, res) => {
    const { feedbackId } = req.params;
    const studentUserId = req.user.id;
    const { reject_reason } = req.body; // 프론트에서 거절 사유를 받을 수 있도록 (선택 사항)

    const t = await ClassFeedback.sequelize.transaction(); // 트랜잭션 시작

    try {
        const feedback = await ClassFeedback.findByPk(feedbackId, { transaction: t });

        if (!feedback) {
            await t.rollback();
            return res.status(404).json({ message: '피드백을 찾을 수 없습니다.' });
        }

        // 1. 권한 검증: 이 피드백이 현재 로그인한 학생의 것인지 확인
        if (feedback.user_id !== studentUserId) {
            await t.rollback();
            return res.status(403).json({ message: '자신의 피드백에 대해서만 이 작업을 수행할 수 있습니다.' });
        }

        // 2. 상태 검증: 강사의 공개 요청이 있었고, 아직 승인/거절되지 않은 상태인지 확인
        if (feedback.is_publication_requested !== true) {
            await t.rollback();
            return res.status(400).json({ message: '강사의 공개 요청이 없었거나 이미 처리된 요청입니다.' });
        }
        if (feedback.publish_approved || feedback.publish_rejected) {
            await t.rollback();
            return res.status(400).json({ message: '이미 공개 승인 또는 거절 처리된 피드백입니다.' });
        }

        // 3. 피드백 상태 업데이트: 공개 거절
        feedback.publish_rejected = true;
        feedback.publish_rejected_at = new Date();
        feedback.is_public = false; // 공개되지 않음
        feedback.is_publication_requested = false; // 요청 상태는 '처리됨'으로 변경
        feedback.publish_approved = false; // 혹시 모를 이전 승인 상태 초기화
        if (reject_reason !== undefined) { // 거절 사유가 전달된 경우에만 업데이트
            feedback.reject_reason = reject_reason;
        }

        await feedback.save({ transaction: t });
        await t.commit(); // 모든 작업 성공 시 트랜잭션 커밋

        res.status(200).json({ message: '피드백 공개를 거절했습니다.', feedback });

    } catch (err) {
        if (t && !t.finished) { // 트랜잭션이 아직 완료되지 않았다면 롤백
            try { await t.rollback(); } catch (rbError) { console.error('Rollback error on rejecting feedback publication:', rbError); }
        }
        console.error('피드백 공개 거절 오류:', err);
        res.status(500).json({ message: '서버 오류로 인해 피드백 공개 거절에 실패했습니다.' });
    }
};

exports.getMyReviewForClass = async (req, res) => {
    const { classId } = req.params;
    const studentUserId = req.user.id; // 인증된 학생의 ID

    if (!classId) {
        return res.status(400).json({ message: '수업 ID(classId)는 필수입니다.' });
    }

    try {
        const review = await ClassReview.findOne({
            where: {
                class_id: Number(classId),
                user_id: studentUserId
            },
            // 필요한 모든 필드를 가져옵니다.
            // attributes: ['id', 'rating', 'review_text', 'is_public', 'created_at', 'updated_at'],
            // 만약 User나 Class 정보를 여기서 함께 보여주고 싶다면 include 사용
            // include: [
            //     { model: User, as: 'user', attributes: ['name'] },
            //     { model: Class, as: 'class', attributes: ['title'] }
            // ]
        });

        if (!review) {
            // 학생이 아직 이 수업에 대한 리뷰를 작성하지 않은 경우
            return res.status(404).json({ message: '아직 이 수업에 대한 후기를 작성하지 않았습니다.' });
        }

        // 리뷰에 첨부된 이미지 파일 정보 조회 및 URL 생성
        const images = await UploadFile.findAll({
            where: {
                target_type: 'review', // ClassReview에 연결된 파일의 target_type
                target_id: review.id     // 현재 조회된 review의 ID
            },
            attributes: ['id', 'file_key', 'file_name', 'is_public']
        });

        const imageObjects = await Promise.all(images.map(async (img) => {
            let displayUrl = null;
            // 리뷰 이미지가 private일 경우 Pre-signed URL 생성 (정책에 따라 is_public 확인)
            // 여기서는 모든 리뷰 이미지가 사용자 설정(img.is_public)을 따른다고 가정
            if (img.is_public === false) {
                try {
                    displayUrl = await s3Service.generatePresignedGetUrl(img.file_key);
                } catch (s3Error) {
                    console.error(`Error generating presigned URL for review image ${img.file_key}:`, s3Error);
                }
            } else { // Public 파일
                const bucket = process.env.UPLOAD_BUCKET;
                const region = process.env.AWS_REGION;
                displayUrl = `https://${bucket}.s3.${region}.amazonaws.com/${img.file_key}`;
            }
            return {
                id: img.id,
                file_key: img.file_key,
                name: img.file_name,
                url: displayUrl,
                // MultiImageUploader의 initialFiles에 필요한 다른 속성도 포함 가능
            };
        }));

        // Sequelize 인스턴스를 일반 객체로 변환하고 이미지 정보 추가
        const responseData = {
            ...review.get({ plain: true }),
            images: imageObjects
        };

        res.status(200).json(responseData);

    } catch (err) {
        console.error('내 리뷰 조회 오류:', err);
        res.status(500).json({ message: '서버 오류로 리뷰 조회에 실패했습니다.' });
    }
};

/**
 * 학생이 특정 수업에 대한 리뷰를 새로 작성합니다.
 */
exports.createClassReview = async (req, res) => {
    const {
        class_id,
        rating,
        review_text,
        is_public = false, // 기본값은 비공개
        file_keys = []     // 첨부된 이미지 파일들의 키 배열
    } = req.body;

    const studentUserId = req.user.id; // 현재 로그인한 학생의 ID
    const now = new Date();

    // Sequelize 트랜잭션 시작
    // ClassReview 모델이 sequelize 인스턴스를 가지고 있다고 가정합니다.
    // 만약 그렇지 않다면, db.sequelize.transaction() 등으로 sequelize 인스턴스를 직접 사용해야 합니다.
    const t = await ClassReview.sequelize.transaction();

    try {
        // 1. 필수 값 검증
        if (!class_id || !studentUserId) {
            await t.rollback();
            return res.status(400).json({ message: '수업 ID와 사용자 ID는 필수입니다.' });
        }
        if (rating === undefined || rating === null || rating < 1 || rating > 5) {
            await t.rollback();
            return res.status(400).json({ message: '평점은 1에서 5 사이의 값이어야 합니다.' });
        }
        if (!review_text || review_text.trim() === '') { // 리뷰 내용은 필수라고 가정
            await t.rollback();
            return res.status(400).json({ message: '리뷰 내용을 입력해주세요.' });
        }

        // 2. 수업(Class) 존재 및 종료 여부 확인
        const targetClass = await Class.findByPk(class_id, { transaction: t });
        if (!targetClass) {
            await t.rollback();
            return res.status(404).json({ message: '리뷰를 작성할 수업을 찾을 수 없습니다.' });
        }
        // (정책) 수업이 종료된 후에만 리뷰를 작성할 수 있도록 제한
        if (targetClass.end_datetime && new Date(targetClass.end_datetime) > now) {
            await t.rollback();
            return res.status(403).json({ message: '수업이 종료된 후에 후기를 작성할 수 있습니다.' });
        }

        // 3. 학생이 해당 수업에 실제로 참여(예약 승인)했는지 확인
        const reservation = await ClassReservation.findOne({
            where: {
                class_id: Number(class_id),
                user_id: studentUserId,
                status: { [Op.in]: ['approved', 'applied', 'cancel_request'] }
            },
            transaction: t
        });
        if (!reservation) {
            await t.rollback();
            return res.status(403).json({ message: '해당 수업을 수강한 학생만 후기를 작성할 수 있습니다.' });
        }

        // 4. 중복 리뷰 작성 방지 (ClassReview 모델의 UNIQUE 제약조건이 처리하지만, API 레벨에서도 확인)
        const existingReview = await ClassReview.findOne({
            where: {
                class_id: Number(class_id),
                user_id: studentUserId
            },
            transaction: t
        });
        if (existingReview) {
            await t.rollback();
            return res.status(409).json({ message: '이미 이 수업에 대한 후기를 작성하셨습니다. 기존 후기를 수정해주세요.' });
        }

        // 5. ClassReview 레코드 생성
        const newReview = await ClassReview.create({
            class_id: Number(class_id),
            user_id: studentUserId,
            rating: Number(rating),
            review_text: review_text,
            is_public: Boolean(is_public) // boolean 값으로 확실히 변환
        }, { transaction: t });

        // 6. 첨부된 이미지 파일 연결 (UploadFile 테이블 업데이트)
        if (file_keys && file_keys.length > 0) {
            await UploadFile.update(
                {
                    target_id: newReview.id,
                    target_type: 'review' // UploadFile 테이블에서 리뷰 이미지를 식별하는 타입
                },
                {
                    where: {
                        file_key: { [Op.in]: file_keys },
                        // 업로드 시점에 user_id와 임시 target_type 등으로 저장했다면, 그 조건도 추가 가능
                    },
                    transaction: t
                }
            );
        }

        await t.commit(); // 모든 작업 성공 시 트랜잭션 커밋

        // 생성된 리뷰 객체 전체 또는 주요 정보 반환
        res.status(201).json({
            message: '후기가 성공적으로 작성되었습니다.',
            reviewId: newReview.id,
            review: newReview // 프론트에서 바로 상태 업데이트에 활용 가능
        });

    } catch (err) {
        // 롤백은 트랜잭션이 아직 완료(커밋 또는 롤백)되지 않았을 때만 시도
        if (t && !t.finished) {
            try {
                await t.rollback();
            } catch (rbError) {
                console.error('Rollback error on creating review:', rbError);
            }
        }
        console.error('리뷰 생성 오류:', err);
        if (err.name === 'SequelizeUniqueConstraintError') { // (class_id, user_id) 중복 오류
            return res.status(409).json({ message: '이미 이 수업에 대한 후기를 작성하셨습니다.' });
        }
        res.status(500).json({ message: '서버 오류로 인해 후기 작성에 실패했습니다.' });
    }
};
