// lib/sessions.js
// جلسات app_session في الذاكرة (Map). تُفقد عند إعادة تشغيل السيرفر —
// مقبول لحجم المشروع الحالي (المستخدم يعيد تسجيل الدخول فقط، لا خسارة بيانات).
const { randomUUID } = require("crypto");

const sessions = new Map(); // token -> { login, role, permissions, createdAt }

function createSession(login, role, permissions) {
  const token = randomUUID();
  sessions.set(token, { login, role, permissions, createdAt: Date.now() });
  return token;
}

function getSession(token) {
  return sessions.get(token) || null;
}

function destroySession(token) {
  sessions.delete(token);
}

module.exports = { createSession, getSession, destroySession };
