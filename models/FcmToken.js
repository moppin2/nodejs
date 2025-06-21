module.exports = (sequelize, DataTypes) => {
  return sequelize.define('FcmToken', {
    fcm_token: {
      type: DataTypes.STRING(512),
      primaryKey: true,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    user_type: {
      type: DataTypes.ENUM('User', 'Instructor', 'Admin'),
      allowNull: false,
    },
    platform: {
      type: DataTypes.ENUM('android', 'ios'),
      allowNull: false,
    },
    device_id: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
  }, {
    tableName: 'fcm_tokens',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
};