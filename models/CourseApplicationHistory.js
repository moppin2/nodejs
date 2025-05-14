module.exports = (sequelize, DataTypes) => {
  return sequelize.define('CourseApplicationHistory', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    application_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'course_applications',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    action: {
      type: DataTypes.ENUM('apply', 'approve', 'reject', 'cancel_request', 'cancel_approve', 'cancel_deny'),
      allowNull: false,
    },
    performed_by: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: '행위자 ID (user or instructor)',
    },
    performer_type: {
      type: DataTypes.ENUM('user', 'instructor', 'admin'),
      allowNull: false,
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  }, {
    tableName: 'course_application_histories',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
  });
};
