module.exports = (sequelize, DataTypes) => {
    return sequelize.define('ClassReservation', {
        id: {
            type: DataTypes.INTEGER,
            autoIncrement: true,
            primaryKey: true,
        },
        class_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'classes',
                key: 'id',
            },
            onDelete: 'CASCADE',
            comment: '예약된 수업 ID',
        },
        user_id: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: {
                model: 'users',
                key: 'id',
            },
            onDelete: 'CASCADE',
            comment: '예약 사용자 ID',
        },
        status: {
            type: DataTypes.ENUM(
                'applied',       // 예약 신청
                'approved',      // 예약 승인
                'rejected',      // 예약 거부
                'cancel_request',// 취소 요청
                'cancelled'      // 예약 취소
            ),
            allowNull: false,
            defaultValue: 'applied',
            comment: '예약 상태',
        },
    }, {
        tableName: 'class_reservations',
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
    });
};