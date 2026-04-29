const express = require('express');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const VAPI_KEY = process.env.VAPI_KEY || '';
const VAPI_PHONE_ID = process.env.VAPI_PHONE_ID || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const ADMIN_TELEGRAM_ID = String(process.env.ADMIN_TELEGRAM_ID || '');

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let temp = {};

const mainKb = {
  keyboard: [['🧠 Prompt', '📞 Nomer'], ['🚪 Logout']],
  resize_keyboard: true
};

const promptKb = {
  keyboard: [
    ["Sen o'zbek tilida tabiiy gaplashadigan call center operatorsan. Mijozning ehtiyojini aniqlab, aniq yechim taklif qil."],
    ["Sen telefon do'koni sotuvchisisan. Mijozga mos model tavsiya qil va muloyim gaplash."],
    ["Sen bank xizmatlari bo'yicha maslahatchisan. Mijozga kredit va karta haqida tushuntir."],
    ["Sen tibbiyot klinikasi administratorisan. Mijozni shifokorga yozib ol va savollariga javob ber."],
    ["Sen internet provayder operatorisan. Mijozning internet muammosini hal qilishga yordam ber."]
  ],
  resize_keyboard: true,
  one_time_keyboard: true
};

const rmKb = { remove_keyboard: true };

const getS = (id) => {
  if (!temp[id]) temp[id] = { step: 'login', login: '', prompt: '', phone: '' };
  return temp[id];
};

const setS = (id, d) => {
  temp[id] = d;
};

const send = async (chatId, text, kb) => {
  try {
    const body = { chat_id: chatId, text };
    if (kb) body.reply_markup = kb;
    await axios.post(`${TG}/sendMessage`, body);
  } catch (e) {
    console.error('SEND ERR:', e.response?.data || e.message);
  }
};

const initDb = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      login TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      is_active BOOLEAN DEFAULT true,
      telegram_id TEXT UNIQUE,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      telegram_id TEXT UNIQUE NOT NULL,
      login TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id TEXT UNIQUE
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP
  `);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW()
  `);
};

const isAdmin = (chatId) => String(chatId) === ADMIN_TELEGRAM_ID;

const isAuthorized = async (chatId) => {
  const r = await pool.query(`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.login = s.login
    WHERE s.telegram_id = $1
      AND u.is_active = true
      AND (u.expires_at IS NULL OR u.expires_at > NOW())
  `, [chatId]);

  if (!r.rows.length) {
    await pool.query('DELETE FROM sessions WHERE telegram_id=$1', [chatId]);
    return false;
  }

  return true;
};

const checkUser = async (chatId, login, password) => {
  const r = await pool.query(
    `SELECT * FROM users
     WHERE login=$1
       AND is_active=true
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [login]
  );

  if (!r.rows.length) return { ok: false, msg: 'Login topilmadi yoki muddati tugagan.' };

  const user = r.rows[0];

  const passOk = await bcrypt.compare(password, user.password);
  if (!passOk) return { ok: false, msg: 'Parol xato.' };

  if (user.telegram_id && String(user.telegram_id) !== String(chatId)) {
    return { ok: false, msg: 'Bu login boshqa Telegram accountga bog‘langan.' };
  }

  if (!user.telegram_id) {
    await pool.query('UPDATE users SET telegram_id=$1 WHERE login=$2', [chatId, login]);
  }

  return { ok: true };
};

const saveSession = async (chatId, login) => {
  await pool.query(`
    INSERT INTO sessions (telegram_id, login)
    VALUES ($1,$2)
    ON CONFLICT (telegram_id)
    DO UPDATE SET login=$2, created_at=NOW()
  `, [chatId, login]);
};

const logout = async (chatId) => {
  await pool.query('DELETE FROM sessions WHERE telegram_id=$1', [chatId]);
};

const addUser = async (login, password, days) => {
  const hash = await bcrypt.hash(password, 10);

  await pool.query(`
    INSERT INTO users (login, password, is_active, expires_at)
    VALUES ($1, $2, true, NOW() + ($3 || ' days')::interval)
    ON CONFLICT (login)
    DO UPDATE SET
      password=$2,
      is_active=true,
      telegram_id=NULL,
      expires_at=NOW() + ($3 || ' days')::interval
  `, [login, hash, days]);
};

const deleteUser = async (login) => {
  await pool.query('DELETE FROM sessions WHERE login=$1', [login]);
  await pool.query('DELETE FROM users WHERE login=$1', [login]);
};

const listUsers = async () => {
  const r = await pool.query(`
    SELECT login, is_active, telegram_id, expires_at
    FROM users
    ORDER BY id DESC
  `);

  if (!r.rows.length) return 'Userlar yo‘q.';

  return r.rows.map((u, i) => {
    const exp = u.expires_at ? new Date(u.expires_at).toLocaleString('uz-UZ') : 'cheksiz';
    const tg = u.telegram_id ? u.telegram_id : 'hali bog‘lanmagan';
    return `${i + 1}. ${u.login}\nStatus: ${u.is_active ? 'active' : 'off'}\nTelegram: ${tg}\nMuddati: ${exp}`;
  }).join('\n\n');
};

const makeCall = async (phone, prompt) => {
  try {
    const n = phone.startsWith('+') ? phone : '+' + phone;

    const r = await axios.post('https://api.vapi.ai/call', {
      phoneNumberId: VAPI_PHONE_ID,
      assistant: {
        model: {
          provider: 'openai',
          model: 'gpt-4o',
          systemPrompt:
            prompt +
            "\n\nMUHIM: Suhbatni o'zbek tilida o'zing boshlaysan. Birinchi gapda o'zingni tanishtir va rolinga mos savol ber.",
          temperature: 0.7,
          maxTokens: 250
        },
        voice: {
          provider: 'azure',
          voiceId: 'uz-UZ-SardorNeural'
        },
        transcriber: {
          provider: 'azure',
          language: 'uz-UZ'
        },
        firstMessageMode: 'assistant-speaks-first',
        endCallFunctionEnabled: false,
        recordingEnabled: false
      },
      customer: { number: n }
    }, {
      headers: { Authorization: `Bearer ${VAPI_KEY}` }
    });

    return { ok: true, id: r.data.id };
  } catch (e) {
    const err = e.response?.data?.message || e.message;
    console.error('Vapi ERR:', JSON.stringify(e.response?.data || e.message));
    return { ok: false, error: err };
  }
};

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    if (!req.body.message) return;

    const msg = req.body.message;
    const chatId = String(msg.chat.id);
    const text = (msg.text || '').trim();
    const name = msg.from?.first_name || "do'st";

    const s = getS(chatId);

    const clean = p => p.replace(/[\s\-\(\)]/g, '');
    const phoneRe = /^\+?[0-9]{9,15}$/;

    if (isAdmin(chatId) && text.startsWith('/adduser')) {
      const parts = text.split(' ');
      const login = parts[1];
      const password = parts[2];
      const days = Number(parts[3] || 7);

      if (!login || !password || !days) {
        await send(chatId, 'Format:\n/adduser ali 1111 7');
        return;
      }

      await addUser(login, password, days);
      await send(chatId, `✅ User qo‘shildi:\nLogin: ${login}\nParol: ${password}\nMuddati: ${days} kun`);
      return;
    }

    if (isAdmin(chatId) && text === '/listusers') {
      const users = await listUsers();
      await send(chatId, users);
      return;
    }

    if (isAdmin(chatId) && text.startsWith('/deluser')) {
      const login = text.split(' ')[1];

      if (!login) {
        await send(chatId, 'Format:\n/deluser ali');
        return;
      }

      await deleteUser(login);
      await send(chatId, `🗑 User o‘chirildi: ${login}`);
      return;
    }

    if (text === '/start' || text === '/menu') {
      if (isAdmin(chatId)) {
        await send(
          chatId,
          `Admin panel:\n\n/adduser ali 1111 7\n/listusers\n/deluser ali\n\nOddiy bot menyusi ham ishlaydi.`,
          mainKb
        );
        return;
      }

      if (await isAuthorized(chatId)) {
        await send(chatId, `Assalomu alaykum, ${name}! ✅ Siz tizimdasiz.`, mainKb);
        return;
      }

      setS(chatId, { step: 'login', login: '', prompt: '', phone: '' });
      await send(chatId, '🔐 Bot yopiq rejimda.\n\nLogin kiriting:', rmKb);
      return;
    }

    if (text === '🚪 Logout' || text === '/logout') {
      await logout(chatId);
      setS(chatId, { step: 'login', login: '', prompt: '', phone: '' });
      await send(chatId, '🔒 Chiqdingiz.\n\nLogin kiriting:', rmKb);
      return;
    }

    if (!isAdmin(chatId) && !(await isAuthorized(chatId))) {
      if (s.step === 'login') {
        setS(chatId, { ...s, step: 'password', login: text });
        await send(chatId, '🔑 Parol kiriting:', rmKb);
        return;
      }

      if (s.step === 'password') {
        const result = await checkUser(chatId, s.login, text);

        if (!result.ok) {
          setS(chatId, { step: 'login', login: '', prompt: '', phone: '' });
          await send(chatId, `❌ ${result.msg}\n\nQaytadan login kiriting:`, rmKb);
          return;
        }

        await saveSession(chatId, s.login);

        setS(chatId, { step: 'waiting_prompt', login: '', prompt: '', phone: '' });

        await send(chatId, '✅ Kirish muvaffaqiyatli!\n\nEndi botdan foydalanishingiz mumkin.', mainKb);
        return;
      }

      setS(chatId, { step: 'login', login: '', prompt: '', phone: '' });
      await send(chatId, '🔐 Login kiriting:', rmKb);
      return;
    }

    if (text === '🧠 Prompt') {
      setS(chatId, { ...s, step: 'waiting_prompt' });
      await send(chatId, '🧠 Prompt yuboring yoki 5 tayyor variantdan tanlang.', promptKb);
      return;
    }

    if (text === '📞 Nomer') {
      setS(chatId, { ...s, step: 'waiting_phone' });
      await send(chatId, '📞 Endi telefon raqam yuboring.\nFormat: +998901234567', rmKb);
      return;
    }

    const cp = clean(text);

    if (phoneRe.test(cp)) {
      if (!s.prompt) {
        setS(chatId, { ...s, phone: cp, step: 'waiting_prompt' });
        await send(chatId, `📞 Nomer saqlandi: ${cp}\n\n🧠 Endi prompt yuboring.`, promptKb);
        return;
      }

      await send(chatId, "⏳ Qo'ng'iroq boshlanmoqda...");

      const r = await makeCall(cp, s.prompt);

      setS(chatId, { step: 'waiting_prompt', login: '', prompt: '', phone: '' });

      await send(
        chatId,
        r.ok
          ? `✅ Qo'ng'iroq muvaffaqiyatli boshlandi!\n📞 ${cp} ga qo'ng'iroq ketmoqda...`
          : `❌ Xato: ${r.error}`,
        mainKb
      );
      return;
    }

    if (text.length >= 5) {
      setS(chatId, { ...s, prompt: text, step: 'waiting_phone' });

      await send(
        chatId,
        `✅ Prompt saqlandi!\n\n📝 "${text.substring(0, 60)}..."\n\n📞 Endi telefon raqam yuboring.\nFormat: +998901234567`,
        rmKb
      );
      return;
    }

    if (text.length > 0) {
      await send(chatId, '❌ Prompt juda qisqa. Kamida 5 belgi kiriting.', promptKb);
    }
  } catch (e) {
    console.error('WEBHOOK ERR:', e.response?.data || e.message);
  }
});

app.get('/', (_, res) => {
  res.json({
    ok: true,
    bot: !!BOT_TOKEN,
    vapi: !!VAPI_KEY,
    phone: !!VAPI_PHONE_ID,
    db: !!DATABASE_URL,
    admin: !!ADMIN_TELEGRAM_ID
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log('Server running on port', PORT);

  try {
    await initDb();
    console.log('Database ready');
  } catch (e) {
    console.error('DB init error:', e.message);
  }

  if (WEBHOOK_URL && BOT_TOKEN) {
    try {
      const r = await axios.post(`${TG}/setWebhook`, {
        url: WEBHOOK_URL + '/webhook',
        drop_pending_updates: true
      });

      console.log('Webhook:', r.data.ok);
    } catch (e) {
      console.error('Webhook err:', e.response?.data || e.message);
    }
  }
});
