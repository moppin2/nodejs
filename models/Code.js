module.exports = (sequelize, DataTypes) => {
    return  sequelize.define('Code', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    group_code: {
      type: DataTypes.STRING(100),
      allowNull: false,
      references: {
        model: 'code_groups',
        key: 'group_code',
      },
      onDelete: 'CASCADE',
      comment: '어느 그룹에 속한 코드인지 (예: LEVEL)',
    },
    code: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: '코드 값 (예: EASY, MEDIUM)',
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: '코드 이름 (예: 쉬움, 보통)',
    },
    sort_order: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: '정렬 순서',
    },
    description: {
      type: DataTypes.TEXT, 
      allowNull: true,
      comment: '설명',
    },
  }, {
    tableName: 'codes',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
}
