const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const VAPI_KEY = process.env.VAPI_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
const VAPI_PHONE_ID = process.env.VAPI_PHONE_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── FILE-BASED SESSION ───
const SESSION_FILE = path.join('/tmp', 'sessions.json');

function loadSessions() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    }
  } catch (e) { console.error('Load sessions error:', e.message); }
  return {};
}

function saveSessions(sessions) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions), 'utf8'); }
  catch (e) { console.error('Save sessions error:', e.message); }
}

function getSession(chatId) {
  const sessions = loadSessions();
  if (!sessions[chatId]) {
    sessions[chatId] = { waitingFor: 'waiting_prompt', prompt: '', phone: '' };
    saveSessions(sessions);
  }
  return sessions[chatId];
}

function setSession(chatId, data) {
  const sessions = loadSessions();
  sessions[chatId] = data;
  saveSessions(sessions);
}

// ─── HELPERS ───
async function send(chatId, text, kb) {
  const body = { chat_id: chatId, text };
  if (kb) body.reply_markup = kb;
  try { await axios.post(`${TG}/sendMessage`, body); }
  catch (e) { console.error('send error:', e.response?.data || e.message); }
}

const mainKb = { keyboard: [['🧠 Prompt', '📞 Nomer']], resize_keyboard: true };
const promptKb = {
  keyboard: [
    ["Sen o'zbek tilida tabiiy gaplashadigan call center operatorsan. Mijozning ehtiyojini aniqlab, aniq yechim taklif qil."],
    ["Sen telefon do'koni sotuvchisisan. Mijozga mos model tavsiya qil va muloyim gaplash."],
    ["Sen bank xizmatlari bo'yicha maslahatchisan. Mijozga kredit va karta haqida tushuntir."],
    ["Sen tibbiyot klinikasi administratorisan. Mijozni shifokorga yozib ol va savollariga javob ber."],
    ["Sen internet provayder operatorisan. Mijozning internet muammosini hal qilishga yordam ber."]
  ],
  resize_keyboard: true, one_time_keyboard: true
};
const rmKb = { remove_keyboard: true };

async function makeCall(phone, prompt) {
  try {
    const n = phone.startsWith('+') ? phone : '+' + phone;
    const r = await axios.post('https://api.vapi.ai/call', {
      phoneNumberId: VAPI_PHONE_ID,
      assistantId: VAPI_ASSISTANT_ID,
      assistantOverrides: { model: { messages: [{ role: 'system', content: prompt }] } },
      customer: { number: n }
    }, { headers: { Authorization: `Bearer ${VAPI_KEY}` } });
    return { ok: true, id: r.data.id };
  } catch (e) {
    return { ok: false, error: e.response?.data?.message || e.response?.data?.error || e.message };
  }
}

// ─── WEBHOOK ───
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  if (!req.body.message) return;

  const msg = req.body.message;
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const name = msg.from?.first_name || "do'st";

  const phoneRegex = /^\+?[0-9]{9,15}$/;
  const clean = p => p.replace(/[\s\-\(\)]/g, '');

  // /start
  if (['/start', '/menu'].includes(text)) {
    setSession(chatId, { waitingFor: 'waiting_prompt', prompt: '', phone: '' });
    await send(chatId,
      `Assalomu alaykum, ${name}! 👋\n\nMen Call Center botman.\n\nNima qila olaman:\n• sizdan PROMPT qabul qilaman\n• sizdan telefon raqam qabul qilaman\n• ikkalasi tayyor bo'lsa Vapi orqali qo'ng'iroqni boshlayman\n\nPastdagi tugmalardan birini bosing:`,
      mainKb
    );
    return;
  }

  const s = getSession(chatId);

  // 🧠 Prompt button
  if (text === '🧠 Prompt') {
    setSession(chatId, { ...s, waitingFor: 'waiting_prompt' });
    await send(chatId, '🧠 Prompt yuboring yoki pastdagi 5 ta tayyor promptdan birini tanlang.', promptKb);
    return;
  }

  // 📞 Nomer button
  if (text === '📞 Nomer') {
    setSession(chatId, { ...s, waitingFor: 'waiting_phone' });
    await send(chatId, '📞 Endi telefon raqam yuboring.\nFormat: +998901234567', rmKb);
    return;
  }

  // Auto-detect: if looks like phone number, treat as phone
  const cleanedText = clean(text);
  if (phoneRegex.test(cleanedText)) {
    const phone = cleanedText;
    if (!s.prompt) {
      setSession(chatId, { ...s, phone, waitingFor: 'waiting_prompt' });
      await send(chatId, `📞 Nomer saqlandi: ${phone}\n\n🧠 Endi prompt yuboring.`, promptKb);
      return;
    }
    await send(chatId, '⏳ Qo\'ng\'iroq boshlanmoqda...');
    const result = await makeCall(phone, s.prompt);
    setSession(chatId, { waitingFor: 'waiting_prompt', prompt: '', phone: '' });
    await send(chatId,
      result.ok
        ? `✅ Qo'ng'iroq muvaffaqiyatli boshlandi!\n📞 ${phone} ga qo'ng'iroq ketmoqda...`
        : `❌ Qo'ng'iroq amalga oshmadi:\n${result.error}`,
      mainKb
    );
    return;
  }

  // Waiting for prompt (text input)
  if (s.waitingFor === 'waiting_prompt' || s.waitingFor !== 'waiting_phone') {
    if (text.length < 5) {
      await send(chatId, '❌ Prompt juda qisqa. Kamida 5 belgi kiriting.', promptKb);
      return;
    }
    setSession(chatId, { ...s, prompt: text, waitingFor: 'waiting_phone' });
    await send(chatId, '✅ Prompt saqlandi!\n\n📞 Endi telefon raqam yuboring.\nFormat: +998901234567', rmKb);
    return;
  }

  // Unknown
  setSession(chatId, { waitingFor: 'waiting_prompt', prompt: '', phone: '' });
  await send(chatId, "Tushunmadim.\n/start bosing.", mainKb);
});

app.get('/', (_, res) => res.send('✅ Vapi Caller Bot ishlayapti!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('✅ Server ' + PORT + ' portda ishga tushdi');
  if (WEBHOOK_URL) {
    try {
      const r = await axios.post(`${TG}/setWebhook`, {
        url: WEBHOOK_URL + '/webhook',
        drop_pending_updates: true
      });
      console.log('Webhook:', r.data.description);
    } catch (e) { console.error('Webhook error:', e.message); }
  }
});