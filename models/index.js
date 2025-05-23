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
// 수업 관련 모델
db.Class = require('./Class')(sequelize, DataTypes);
db.ClassReservation = require('./ClassReservation')(sequelize, DataTypes);
db.ClassReservationHistory = require('./ClassReservationHistory')(sequelize, DataTypes);
db.ClassFeedback = require('./ClassFeedback')(sequelize, DataTypes);
db.ClassReview = require('./ClassReview')(sequelize, DataTypes);

db.RefreshToken = require('./RefreshToken')(sequelize, DataTypes);
db.CodeGroup = require('./CodeGroup')(sequelize, DataTypes);
db.Code = require('./Code')(sequelize, DataTypes);
db.UploadFile = require('./UploadFile')(sequelize, DataTypes);
db.License = require('./License')(sequelize, DataTypes);
db.InstructorVerificationHistory = require('./InstructorVerificationHistory')(sequelize, DataTypes);
db.CourseApplication = require('./CourseApplication')(sequelize, DataTypes);
db.CourseApplicationHistory = require('./CourseApplicationHistory')(sequelize, DataTypes);

// 관계 정의
// Instructor - Course
db.Course.belongsTo(db.Instructor, { foreignKey: 'instructor_id', as: 'instructor' });
db.Instructor.hasMany(db.Course, { foreignKey: 'instructor_id', as: 'courses' });

// Course - CompletionCriteria
db.Course.hasMany(db.CourseCompletionCriteria, { foreignKey: 'course_id', as: 'completionCriteria' });
db.CourseCompletionCriteria.belongsTo(db.Course, { foreignKey: 'course_id', as: 'course' });

// CodeGroup - Code
db.CodeGroup.hasMany(db.Code, { foreignKey: 'group_code', sourceKey: 'group_code', as: 'codes' });
db.Code.belongsTo(db.CodeGroup, { foreignKey: 'group_code', targetKey: 'group_code', as: 'group' });

// Course - License, Level, Region
db.Course.belongsTo(db.License, { foreignKey: 'license_id', as: 'license' });
db.Course.belongsTo(db.Code, { foreignKey: 'level_code', targetKey: 'code', as: 'level' });
db.Course.belongsTo(db.Code, { foreignKey: 'region_code', targetKey: 'code', as: 'region' });

// Class - Course
db.Class.belongsTo(db.Course, { foreignKey: 'course_id', as: 'course' });

// Course - CourseApplication
db.Course.hasMany(db.CourseApplication, { as: 'applications', foreignKey: 'course_id' });
db.CourseApplication.belongsTo(db.Course, { foreignKey: 'course_id', as: 'course' });
// CourseApplication - User
db.CourseApplication.belongsTo(db.User, { as: 'user', foreignKey: 'user_id' });

// ClassReservation 관계 정의
// Class - ClassReservation
db.Class.hasMany(db.ClassReservation, { foreignKey: 'class_id', as: 'reservations' });
db.ClassReservation.belongsTo(db.Class, { foreignKey: 'class_id', as: 'class' });
// ClassReservation - User
db.ClassReservation.belongsTo(db.User, { foreignKey: 'user_id', as: 'user' });
db.User.hasMany(db.ClassReservation, { foreignKey: 'user_id', as: 'classReservations' });
// ClassReservation - History
db.ClassReservation.hasMany(db.ClassReservationHistory, { foreignKey: 'reservation_id', as: 'histories' });
db.ClassReservationHistory.belongsTo(db.ClassReservation, { foreignKey: 'reservation_id', as: 'reservation' });
// ClassFeedback relationships
db.ClassFeedback.belongsTo(db.Class, { foreignKey: 'class_id', as: 'class' });
db.Class.hasMany(db.ClassFeedback, { foreignKey: 'class_id', as: 'feedbacks' });
db.ClassFeedback.belongsTo(db.User, { foreignKey: 'user_id', as: 'user' });
db.User.hasMany(db.ClassFeedback, { foreignKey: 'user_id', as: 'feedbacks' });
// ClassReview relationships
db.ClassReview.belongsTo(db.Class, { foreignKey: 'class_id', as: 'class' });
db.Class.hasMany(db.ClassReview, { foreignKey: 'class_id', as: 'reviews' });
db.ClassReview.belongsTo(db.User, { foreignKey: 'user_id', as: 'user' });
db.User.hasMany(db.ClassReview, { foreignKey: 'user_id', as: 'reviews' });

module.exports = db;
