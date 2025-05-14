const { Sequelize, DataTypes } = require('sequelize');
const sequelize = new Sequelize('mydb', 'root', '2331', {
  host: 'localhost',
  port: 3306,
  dialect: 'mysql',
  logging: false
});

const db = {};

db.sequelize = sequelize;
db.Sequelize = Sequelize;

// 모델 불러오기
db.User = require('./User')(sequelize, DataTypes);
db.Instructor = require('./Instructor')(sequelize, DataTypes);
db.Admin = require('./Admin')(sequelize, DataTypes);
db.Course = require('./Course')(sequelize, DataTypes);
db.CourseCompletionCriteria = require('./CourseCompletionCriteria')(sequelize, DataTypes);
db.RefreshToken = require('./RefreshToken')(sequelize, DataTypes);
db.CodeGroup = require('./CodeGroup')(sequelize, DataTypes);
db.Code = require('./Code')(sequelize, DataTypes);
db.UploadFile = require('./UploadFile')(sequelize, DataTypes);
db.License = require('./License')(sequelize, DataTypes);
db.InstructorVerificationHistory = require('./InstructorVerificationHistory')(sequelize, DataTypes);
db.CourseApplication = require('./CourseApplication')(sequelize, DataTypes);
db.CourseApplicationHistory = require('./CourseApplicationHistory')(sequelize, DataTypes);

// 관계 정의
db.Course.belongsTo(db.Instructor, { foreignKey: 'instructor_id', as: 'instructor' });
db.Instructor.hasMany(db.Course, { foreignKey: 'instructor_id', as: 'courses' });

db.Course.hasMany(db.CourseCompletionCriteria, { foreignKey: 'course_id', as: 'completionCriteria' });
db.CourseCompletionCriteria.belongsTo(db.Course, { foreignKey: 'course_id', as: 'course' });

db.CodeGroup.hasMany(db.Code, { foreignKey: 'group_code', sourceKey: 'group_code', as: 'codes' });
db.Code.belongsTo(db.CodeGroup, { foreignKey: 'group_code', targetKey: 'group_code', as: 'group' });

db.Course.belongsTo(db.License, {
  foreignKey: 'license_id',
  as: 'license',
});
db.Course.belongsTo(db.Code, {
  foreignKey: 'level_code',
  targetKey: 'code',
  as: 'level',
});
db.Course.belongsTo(db.Code, {
  foreignKey: 'region_code',
  targetKey: 'code',
  as: 'region',
});

module.exports = db; 
