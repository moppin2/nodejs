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
    title: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    association_code: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    level_code: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    region_code: {
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
  }, {
    tableName: 'courses',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
}
