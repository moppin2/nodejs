module.exports = (sequelize, DataTypes) => {
  return sequelize.define('Instructor', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    email: { type: DataTypes.STRING(255), unique: true, allowNull: false },
    pwd_hash: { type: DataTypes.STRING(255), allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    phone_number: { type: DataTypes.STRING(20), allowNull: false },
    joined_at: { type: DataTypes.STRING(100) },
    status: {
      type: DataTypes.ENUM('draft', 'submitted', 'approved', 'rejected'),
      allowNull: false,
      defaultValue: 'draft'
    },
    approved_at: { type: DataTypes.STRING(100) },
    career_years: { type: DataTypes.STRING(100) },
    main_experience: { type: DataTypes.TEXT },
    comment: { type: DataTypes.TEXT },
    balance: { type: DataTypes.STRING(100) },
  }, {
    tableName: 'instructors',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
};

