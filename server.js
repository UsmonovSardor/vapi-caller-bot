const express = require('express');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// ENV
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const VAPI_KEY = process.env.VAPI_KEY || '';
const VAPI_PHONE_ID = process.env.VAPI_PHONE_ID || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

// DB
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// INIT TABLES
const initDb = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      login TEXT UNIQUE,
      password TEXT,
      is_active BOOLEAN DEFAULT true
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      telegram_id TEXT UNIQUE,
      login TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
};

initDb();

// SESSION MEMORY
let temp = {};

const getS = (id) => {
  if (!temp[id]) temp[id] = { step: 'login', login: '' };
  return temp[id];
};

const setS = (id, d) => temp[id] = d;

// SEND
const send = async (chatId, text, kb) => {
  const body = { chat_id: chatId, text };
  if (kb) body.reply_markup = kb;
  await axios.post(`${TG}/sendMessage`, body);
};

const mainKb = {
  keyboard: [['🧠 Prompt', '📞 Nomer'], ['🚪 Logout']],
  resize_keyboard: true
};

// CHECK SESSION
const isAuthorized = async (chatId) => {
  const r = await pool.query(
    'SELECT * FROM sessions WHERE telegram_id=$1',
    [chatId]
  );
  return r.rows.length > 0;
};

// LOGIN
const checkUser = async (login, password) => {
  const r = await pool.query(
    'SELECT * FROM users WHERE login=$1 AND is_active=true',
    [login]
  );

  if (!r.rows.length) return false;

  const user = r.rows[0];
  return await bcrypt.compare(password, user.password);
};

// SAVE SESSION
const saveSession = async (chatId, login) => {
  await pool.query(`
    INSERT INTO sessions (telegram_id, login)
    VALUES ($1,$2)
    ON CONFLICT (telegram_id)
    DO UPDATE SET login=$2
  `, [chatId, login]);
};

// LOGOUT
const logout = async (chatId) => {
  await pool.query(
    'DELETE FROM sessions WHERE telegram_id=$1',
    [chatId]
  );
};

// WEBHOOK
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  if (!req.body.message) return;

  const msg = req.body.message;
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();

  const s = getS(chatId);

  // START
  if (text === '/start') {
    if (await isAuthorized(chatId)) {
      await send(chatId, '✅ Siz allaqachon tizimdasiz', mainKb);
      return;
    }

    setS(chatId, { step: 'login' });
    await send(chatId, '🔐 Login kiriting:');
    return;
  }

  // LOGOUT
  if (text === '🚪 Logout') {
    await logout(chatId);
    setS(chatId, { step: 'login' });
    await send(chatId, '🔒 Chiqdingiz. Login kiriting:');
    return;
  }

  // AUTH FLOW
  if (!(await isAuthorized(chatId))) {
    if (s.step === 'login') {
      setS(chatId, { step: 'password', login: text });
      await send(chatId, '🔑 Parol kiriting:');
      return;
    }

    if (s.step === 'password') {
      const ok = await checkUser(s.login, text);

      if (!ok) {
        setS(chatId, { step: 'login' });
        await send(chatId, '❌ Xato. Loginni qayta kiriting:');
        return;
      }

      await saveSession(chatId, s.login);

      await send(chatId, '✅ Kirish muvaffaqiyatli!', mainKb);

      setS(chatId, {});
      return;
    }

    return;
  }

  // ===== BU YERDA SENING OLDINGI LOGIKA =====
  if (text === '🧠 Prompt') {
    setS(chatId, { ...s, step: 'prompt' });
    await send(chatId, 'Prompt yubor:');
    return;
  }

  if (text === '📞 Nomer') {
    setS(chatId, { ...s, step: 'phone' });
    await send(chatId, 'Telefon yubor:');
    return;
  }

  // (qolgan eski logikang shu yerda qoladi)
});

// START
app.listen(process.env.PORT || 3000, async () => {
  console.log('Server running');
});
