module.exports = (sequelize, DataTypes) => {
  return sequelize.define('Admin', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    email: { type: DataTypes.STRING(255), unique: true, allowNull: false },
    pwd_hash: { type: DataTypes.STRING(255), allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    phone_number: { type: DataTypes.STRING(20), allowNull: false },
    role: { type: DataTypes.ENUM('super', 'manager'), defaultValue: 'manager', allowNull: false }
  }, {
    tableName: 'admins',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
};
