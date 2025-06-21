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
db.StudentCourseProgress = require('./StudentCourseProgress')(sequelize, DataTypes);
// 채팅 관련 모델
db.ChatRoom = require('./ChatRoom')(sequelize, DataTypes);
db.ChatRoomParticipant = require('./ChatRoomParticipant')(sequelize, DataTypes);
db.ChatMessage = require('./ChatMessage')(sequelize, DataTypes);
// Fcm Token 모델
db.FcmToken = require('./FcmToken')(sequelize, DataTypes);



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

// User 모델과 StudentCourseProgress 관계
db.User.hasMany(db.StudentCourseProgress, {
    foreignKey: 'user_id',
    as: 'courseProgress' // 사용자가 통과한 수료 기준 목록
});
db.StudentCourseProgress.belongsTo(db.User, {
    foreignKey: 'user_id',
    as: 'user'
});

// CourseCompletionCriteria 모델과 StudentCourseProgress 관계
db.CourseCompletionCriteria.hasMany(db.StudentCourseProgress, {
    foreignKey: 'criterion_id',
    as: 'progressRecords' // 이 수료 기준을 통과한 학생들의 기록
});
db.StudentCourseProgress.belongsTo(db.CourseCompletionCriteria, { 
    foreignKey: 'criterion_id',
    as: 'criterion'
});

// Class 모델과 StudentCourseProgress 관계
db.Class.hasMany(db.StudentCourseProgress, {
    foreignKey: 'class_id',
    as: 'passedCriteriaRecords' // 이 수업에서 통과 처리된 기준 기록들
});
db.StudentCourseProgress.belongsTo(db.Class, {
    foreignKey: 'class_id',
    as: 'classWherePassed' // 어느 수업에서 통과했는지
});

// ChatRoom 관계
db.ChatRoom.hasMany(db.ChatRoomParticipant, { foreignKey: 'chat_room_id', as: 'participants' });
db.ChatRoom.hasMany(db.ChatMessage, { foreignKey: 'chat_room_id', as: 'messages' });

// ChatRoomParticipant 관계
db.ChatRoomParticipant.belongsTo(db.ChatRoom, { foreignKey: 'chat_room_id', as: 'chatRoom' });

// ChatMessage 관계
db.ChatMessage.belongsTo(db.ChatRoom, { foreignKey: 'chat_room_id', as: 'chatRoom' });

db.ChatRoom.belongsTo(db.Course, { foreignKey: 'related_course_id', as: 'relatedCourse' });
db.ChatRoom.belongsTo(db.Class, { foreignKey: 'related_class_id', as: 'relatedClass' });


module.exports = db;
