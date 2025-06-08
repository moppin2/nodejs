module.exports = (sequelize, DataTypes) => {
  return sequelize.define('ChatMessage', {
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
    sender_type: {
      type: DataTypes.ENUM('user', 'instructor', 'admin'),
      allowNull: false,
    },
    sender_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    message_type: {
      type: DataTypes.ENUM('text', 'image', 'file', 'system'),
      allowNull: false,
      defaultValue: 'text',
    },
    read_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  }, {
    tableName: 'chat_messages',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
};
