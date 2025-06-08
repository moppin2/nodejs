module.exports = (sequelize, DataTypes) => {
  return sequelize.define('ChatRoom', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    room_type: {
      type: DataTypes.ENUM('personal', 'group', 'course', 'class'),
      allowNull: false,
      comment: '채팅방 종류',
    },
    related_course_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'room_type이 course일 경우 관련된 과정 ID',
    },
    related_class_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'room_type이 class일 경우 관련된 수업 ID',
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: '그룹 채팅방의 제목 (선택)',
    },
  }, {
    tableName: 'chat_rooms',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
};
