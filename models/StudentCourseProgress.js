
module.exports = (sequelize, DataTypes) => {
    return sequelize.define('StudentCourseProgress', {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
        },
        user_id: { // 피드백을 받은 학생 ID
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'users', // 실제 User 테이블명
                key: 'id',
            },
            onDelete: 'CASCADE',
        },
        criterion_id: { // 통과한 수료 기준 ID
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'course_completion_criterias', // 실제 CourseCompletionCriteria 테이블명
                key: 'id',
            },
            onDelete: 'CASCADE',
        },
        class_id: { // 어느 수업에서 이 기준을 통과했는지 기록 (필수)
            type: DataTypes.INTEGER,
            allowNull: false, // <<--- 필수로 변경
            references: {
                model: 'classes', // 실제 Class 테이블명
                key: 'id',
            },
            onDelete: 'CASCADE', // 수업 삭제 시 이 기록도 함께 삭제 (정책에 따라 변경 가능)
        },
        // passed_at 필드는 제거하고, 필요시 class의 시간 정보 또는 이 레코드의 created_at을 활용
        notes: { // 선택 사항, 통과 시 강사 메모 등
            type: DataTypes.TEXT,
            allowNull: true,
        },
    }, {
        tableName: 'student_course_progress',
        timestamps: true, // created_at, updatedAt 자동 생성 (created_at이 '기록 시점'이 됨)
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        indexes: [
            {
                unique: true,
                fields: ['user_id', 'criterion_id'], // 한 학생은 각 수료 기준을 한 번만 최종 통과
                name: 'uq_user_criterion_pass'
            },
            {
                fields: ['user_id'],
            },
            {
                fields: ['criterion_id'],
            },
            {
                fields: ['class_id'],
            }
        ]
    });
};