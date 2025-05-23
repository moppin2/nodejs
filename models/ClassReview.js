// src/models/ClassReview.js

module.exports = (sequelize, DataTypes) => {
  return sequelize.define('ClassReview', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    class_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'classes', key: 'id' },
      onDelete: 'CASCADE',
      comment: '수업 회차 ID',
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
      comment: '리뷰 작성 학생 ID',
    },
    rating: {
      type: DataTypes.TINYINT,
      allowNull: false,
      comment: '평점 (1~5)',
    },
    review_text: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: '학생이 남긴 후기 내용',
    },
    is_public: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: '리뷰 공개 여부',
    },
  }, {
    tableName: 'class_reviews',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        unique: true,
        fields: ['class_id', 'user_id'],
        name: 'uq_review_class_user'
      }
    ]
  });
};
