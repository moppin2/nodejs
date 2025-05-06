module.exports = (sequelize, DataTypes) => {
  return  sequelize.define('RefreshToken', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    user_type: { type: DataTypes.ENUM('user', 'instructor'), allowNull: false },
    token: { type: DataTypes.TEXT, allowNull: false },
    user_agent: { type: DataTypes.STRING(255) },
    ip_address: { type: DataTypes.STRING(45) },
    expires_at: { type: DataTypes.DATE, allowNull: false },
  }, {
    tableName: 'refresh_tokens',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        unique: true,
        fields: ['user_id', 'user_type']  // ✅ 복합 유니크 키
      }
    ]
  });
}