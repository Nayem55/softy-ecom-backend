const jwt = require('jsonwebtoken');
const { getDB } = require('../config/db');

async function adminAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Access denied' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

    const db = getDB();
    const admin = await db.collection('admins').findOne({ _id: require('mongodb').ObjectId.createFromHexString(decoded.id) }, { projection: { password: 0 } });
    if (!admin) return res.status(401).json({ error: 'Admin not found' });

    req.admin = admin;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function generateToken(user, role = 'user') {
  return jwt.sign({ id: user._id.toString(), role }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

module.exports = { adminAuth, generateToken };
