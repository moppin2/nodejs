require('dotenv').config();

module.exports = {
  PORT: process.env.PORT,
  ACCESS_SECRET: process.env.JWT_SECRET,
  REFRESH_SECRET: process.env.REFRESH_TOKEN_SECRET,
  CLIENT_URL: process.env.CLIENT_URL,
  COOKIE_SECURE: process.env.COOKIE_SECURE === 'true'
};
