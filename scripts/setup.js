const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const target = path.join(root, '.env');
if (!fs.existsSync(target)) {
  const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  fs.writeFileSync(target, template.replace('JWT_SECRET=', `JWT_SECRET=${crypto.randomBytes(64).toString('hex')}`)
    .replace('ADMIN_PASSWORD=', `ADMIN_PASSWORD=${crypto.randomBytes(30).toString('base64url')}`), { flag: 'wx', mode: 0o600 });
  console.log('Generated local .env credentials. Values are intentionally not logged.');
} else console.log('Existing .env preserved.');
fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
fs.mkdirSync(path.join(root, 'public', 'uploads'), { recursive: true });
