module.exports = (sequelize, DataTypes) => {
  return sequelize.define('InstructorVerificationHistory', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    instructor_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'instructors',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    action: {
      type: DataTypes.ENUM('submitted', 'approved', 'rejected'),
      allowNull: false,
      comment: '심사 상태 변경 이벤트',
    },
    performed_by: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '행위자 ID (강사 or 관리자)',
    },
    performer_type: {
      type: DataTypes.ENUM('instructor', 'admin'),
      allowNull: false,
      comment: '행위자의 유형',
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: '반송 시 사유 또는 메모',
    },
  }, {
    tableName: 'instructor_verification_histories',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
  });
};
