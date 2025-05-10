module.exports = (sequelize, DataTypes) => {
    return sequelize.define('UploadFile', {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      target_type: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '연결된 테이블 이름 (예: user, course, post)',
      },
      target_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '연결된 테이블의 PK',
      },
      purpose: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '파일 용도 (예: profile, thumbnail, attachment)',
      },
      file_name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: '사용자가 업로드한 원본 파일명',
      },
      file_key: {
        type: DataTypes.STRING(255),
        allowNull: false,
        unique: true,
        comment: 'S3 상의 파일 경로 및 이름 (예: uploads/user/101-profile.jpg)',
      },
      file_type: {
        type: DataTypes.STRING(100),
        allowNull: true,
        comment: 'MIME 타입 (예: image/png, application/pdf)',
      },
      size: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: '파일 크기 (byte)',
      },
      is_public: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: '공개 여부 (true = 누구나 접근 가능)',
      },
      deleted_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: '삭제 시각 (soft delete)',
      },
    }, {
      tableName: 'upload_files',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      paranoid: false, // soft delete는 deleted_at 필드로 직접 관리
      indexes: [
        {
          fields: ['target_type', 'target_id'],
          name: 'idx_target',
        },
      ],
    });
  };
  