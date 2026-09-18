const { ObjectId } = require('mongodb');
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (message, status = 400) => { throw new HttpError(status, message); };
function str(value, name, max = 500, required = false) {
  if (value === undefined || value === null) { if (required) fail(`${name} is required`); return ''; }
  if (typeof value !== 'string' || value.length > max) fail(`Invalid ${name}`);
  const result = value.trim();
  if (required && !result) fail(`${name} is required`);
  return result;
}
function num(value, name, min = 0, max = 10000000, integer = false) {
  if (value === null || value === '' || !['number', 'string'].includes(typeof value)) fail(`Invalid ${name}`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) fail(`Invalid ${name}`);
  return result;
}
function bool(v, fallback = false) {
  if (v === undefined) return fallback;
  if ([true, 'true', 1, '1'].includes(v)) return true;
  if ([false, 'false', 0, '0', ''].includes(v)) return false;
  fail('Invalid boolean');
}
function id(v) { if (typeof v !== 'string' || !/^[a-f\d]{24}$/i.test(v)) fail('Invalid ID'); return new ObjectId(v); }
function array(v, name, max = 100) { if (!Array.isArray(v) || v.length > max) fail(`Invalid ${name}`); return v; }
const strings = (v, name) => array(typeof v === 'string' ? v.split(',').filter(Boolean) : v, name).map(x => str(x, name, 2000, true));
const slug = v => str(v, 'slug', 200, true).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function email(v) { const s = str(v, 'email', 254, true).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail('Invalid email'); return s; }
function password(v) { if (typeof v !== 'string' || v.length < 12 || Buffer.byteLength(v) > 72) fail('Password must be 12 to 72 bytes'); return v; }
function url(v, name = 'URL') {
  const s = str(v, name, 2000);
  if (!s) return '';
  if (s.startsWith('/') && !s.startsWith('//') && !s.includes('\\') && !/[\x00-\x20]/.test(s)) return s;
  try { const u = new URL(s); if (['https:', 'http:'].includes(u.protocol) && !u.username && !u.password) return s; } catch {}
  fail(`Invalid ${name}`);
}
function paging(q, max = 500) { return { page: num(q.page ?? 1, 'page', 1, 100000, true), limit: num(q.limit ?? 20, 'limit', 1, max, true) }; }
const regex = v => str(v, 'search', 160).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const money = v => Math.round((v + Number.EPSILON) * 100) / 100;
function safeInput(value, depth = 0) {
  if (depth > 12) fail('Input nesting too deep');
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('.') || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('Unsafe input key');
    safeInput(value[key], depth + 1);
  }
}
function address(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('Shipping address required');
  const a = { name: str(v.name ?? v.fullName, 'name', 120, true), phone: str(v.phone, 'phone', 24, true),
    address: str(v.address ?? v.addressLine1, 'address', 600, true), district: str(v.district, 'district', 100, true),
    email: v.email ? email(v.email) : '', city: str(v.city, 'city', 100), postalCode: str(v.postalCode, 'postalCode', 20),
    area: str(v.area, 'area', 100), notes: str(v.notes, 'notes', 1000) };
  if (!/^\+?[\d\s()-]{7,24}$/.test(a.phone)) fail('Invalid phone');
  return a;
}
module.exports = { HttpError, fail, str, num, bool, id, array, strings, slug, email, password, url, paging, regex, money, safeInput, address };
