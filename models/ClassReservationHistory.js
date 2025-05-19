module.exports = (sequelize, DataTypes) => {
    return sequelize.define('ClassReservationHistory', {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
        },
        reservation_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'class_reservations',
                key: 'id',
            },
            onDelete: 'CASCADE',
            comment: '이력 대상 예약 ID',
        },
        action: {
            type: DataTypes.ENUM(
                'apply',          // 예약 신청
                'approve',        // 예약 승인
                'reject',         // 예약 거부
                'cancel_request', // 취소 요청
                'cancel_approve', // 취소 승인
                'cancel_deny'     // 취소 거부
            ),
            allowNull: false,
            comment: '수행된 액션 유형',
        },
        performed_by: {
            type: DataTypes.INTEGER,
            allowNull: false,
            comment: '행위자 ID (user or instructor)',
        },
        performer_type: {
            type: DataTypes.ENUM('user', 'instructor', 'admin'),
            allowNull: false,
            comment: '행위자 유형',
        },
        reason: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: '행위 사유 (취소 요청 등)',
        },
    }, {
        tableName: 'class_reservation_histories',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: false,
    });
};
