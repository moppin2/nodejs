module.exports = (sequelize, DataTypes) => {
  return  sequelize.define('Course', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    instructor_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'instructors',
        key: 'id',
      },
      onDelete: 'SET NULL',
    },
    license_id: {
      type: DataTypes.STRING(50),
      allowNull: false,
      references: {
        model: 'licenses',
        key: 'id',
      },
      onDelete: 'RESTRICT',
      comment: '해당 과정이 대응하는 라이센스 ID',
    },
    level_code: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    region_code: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    title: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    curriculum: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    is_published: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false, // 기본값은 비공개
      comment: '공개 여부 (true: 공개, false: 비공개)'
    },
  }, {
    tableName: 'courses',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
}
