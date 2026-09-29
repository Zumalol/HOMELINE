const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // กำหนดให้ติดตั้ง Chrome ไว้ในโฟลเดอร์ .cache ภายในตัวโปรเจกต์
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};