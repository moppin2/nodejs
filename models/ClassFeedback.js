module.exports = (sequelize, DataTypes) => {
  return sequelize.define('ClassFeedback', {
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
      comment: '수업 회차 ID',
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
      onDelete: 'CASCADE',
      comment: '피드백 대상 학생 ID',
    },
    feedback_text: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: '강사가 남긴 상세 피드백',
    },
    rating: {
      type: DataTypes.TINYINT,
      allowNull: true,
      comment: '선택형 평점 (예: 1~5)',
    },
    is_public: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: '최종 피드백 공개 여부',
    },
    publish_requested_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: '강사가 공개 요청한 시각',
    },
    publish_approved: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: '학생이 공개 요청을 승인했는지',
    },
    publish_approved_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: '학생이 공개 요청을 승인한 시각',
    },
    publish_rejected: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: '학생이 공개 요청을 거절했는지',
    },
    publish_rejected_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: '학생이 공개 요청을 거절한 시각',
    },
    reject_reason: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: '공개 거절 사유',
    },
  }, {
    tableName: 'class_feedbacks',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        unique: true,
        fields: ['class_id', 'user_id'],
        name: 'uq_class_user'
      }
    ]
  });
};
