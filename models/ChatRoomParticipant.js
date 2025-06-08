module.exports = (sequelize, DataTypes) => {
  return sequelize.define('ChatRoomParticipant', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    chat_room_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'chat_rooms',
        key: 'id',
      },
      onDelete: 'CASCADE',
    },
    user_type: {
      type: DataTypes.ENUM('user', 'instructor', 'admin'),
      allowNull: false,
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    joined_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    exited_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  }, {
    tableName: 'chat_room_participants',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
};
