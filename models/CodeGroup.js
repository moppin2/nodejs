module.exports = (sequelize, DataTypes) => {
        return  sequelize.define('CodeGroup', {
    group_code: {
        type: DataTypes.STRING(100),
        primaryKey: true,
        allowNull: false,
        comment: '예: LEVEL, REGION, CATEGORY',
    },
    group_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '그룹 이름 (예: 난이도, 지역)',
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '설명',
    },
    }, {
    tableName: 'code_groups',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    });
}
