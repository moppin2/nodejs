const jwt = require('jsonwebtoken');
const { ACCESS_SECRET, REFRESH_SECRET } = require('../config');
const RefreshToken = require('../models/RefreshToken');
const { v4: uuidv4 } = require('uuid');

function signAccessToken(user) {  
  const payload = {
    userType: user.userType,
    id: user.id,
    email: user.email,
    username: user.username,
    avatarUrl: user.avatarUrl,
  };

  // 강사일 경우에만 status 포함
  if (user.userType === 'instructor' && user.status) {
    payload.status = user.status;
  }

  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '5m' });
}

function signRefreshToken(user) {
  return jwt.sign({ userType: user.userType, id: user.id, jti: uuidv4(), }, REFRESH_SECRET, { expiresIn: '7d' });
}

module.exports = { signAccessToken, signRefreshToken }; 
 