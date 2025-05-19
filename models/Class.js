module.exports = (sequelize, DataTypes) => {
  return sequelize.define('Class', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    course_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'courses',
        key: 'id',
      },
      onDelete: 'CASCADE',
      index: true,
    },
    title: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: '수업명',
    },
    start_datetime: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: '수업 시작 일시 (날짜 및 시간)',
    },
    end_datetime: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: '수업 종료 일시 (날짜 및 시간)',
    },
    location: {
      type: DataTypes.STRING(200),
      allowNull: true,
      comment: '수업 장소',
    },
    capacity: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: '최대 수강 인원',
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: '수업설명',
    },
    materials: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: '준비물 목록',
    },
    additional_fees: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: '추가로 발생 가능한 요금 안내',
    },
    is_reservation_closed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: '예약 마감 여부',
    },
  }, {
    tableName: 'classes',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
};
