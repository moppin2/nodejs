module.exports = (sequelize, DataTypes) => {
  return sequelize.define('CourseApplication', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    course_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'courses',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    status: {
      type: DataTypes.ENUM('applied', 'approved', 'rejected', 'cancel_pending', 'cancelled'),
      allowNull: false,
      defaultValue: 'applied',
    },
  }, {
    tableName: 'course_applications',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
};
