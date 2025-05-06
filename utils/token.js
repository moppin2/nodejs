const jwt = require('jsonwebtoken');
const { ACCESS_SECRET, REFRESH_SECRET } = require('../config');
const RefreshToken = require('../models/RefreshToken');

function signAccessToken(user) {
  return jwt.sign({ userType: user.userType, id: user.id, email: user.email, username: user.username }, ACCESS_SECRET, { expiresIn: '5m' });
}

function signRefreshToken(user) {
  return jwt.sign({ userType: user.userType, id: user.id }, REFRESH_SECRET, { expiresIn: '7d' });
}

module.exports = { signAccessToken, signRefreshToken };
