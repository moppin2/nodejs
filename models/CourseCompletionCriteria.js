module.exports = (sequelize, DataTypes) => {
  return  sequelize.define('CourseCompletionCriteria', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    course_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'courses', // 실제 테이블명
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    type: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: '예: 출석, 퀴즈, 과제 등',
    },
    value: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: '예: 80% 이상, 70점 이상 등',
    },
    sort_order: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: '출력 순서',
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: '기준 상세 설명',
    },
  }, {
    tableName: 'course_completion_criterias',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
}