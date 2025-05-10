module.exports = (sequelize, DataTypes) => {
    return sequelize.define('License', {
      id: {
        type: DataTypes.STRING(50), // ex: 'aida-2'
        primaryKey: true,
        comment: '라이센스 고유 ID',
      },
      association: {
        type: DataTypes.STRING(50),
        allowNull: false,
        comment: '협회 이름 (예: AIDA, PADI)',
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '표시 이름 (예: AIDA 2)',
      },
      level_code: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: '레벨 코드 (codes 테이블의 LEVEL)',
        references: {
          model: 'codes',
          key: 'code',
        },
      },
      depth_requirement: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '수심 요구 (미터)',
      },
      static_apnea_requirement: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '정적 호흡 요구 (초)',
      },
      dynamic_apnea_requirement: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '동적 잠영 거리 요구 (미터)',
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: '설명 또는 특이사항', 
      },
      sort_order: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: '표시 순서',
      },
    }, {
      tableName: 'licenses',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    });
  };
  