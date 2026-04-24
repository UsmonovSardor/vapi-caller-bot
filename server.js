const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const VAPI_KEY = process.env.VAPI_KEY || '';
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || '';
const VAPI_PHONE_ID = process.env.VAPI_PHONE_ID || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

console.log('BOT_TOKEN exists:', !!BOT_TOKEN);
console.log('VAPI_KEY exists:', !!VAPI_KEY);
console.log('VAPI_ASSISTANT_ID:', VAPI_ASSISTANT_ID);
console.log('VAPI_PHONE_ID:', VAPI_PHONE_ID);

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

let sessions = {};
const getS = (id) => {
  if (!sessions[id]) sessions[id] = { waitingFor: 'waiting_prompt', prompt: '', phone: '' };
  return sessions[id];
};
const setS = (id, d) => { sessions[id] = d; };

const send = async (chatId, text, kb) => {
  const body = { chat_id: chatId, text };
  if (kb) body.reply_markup = kb;
  try { await axios.post(`${TG}/sendMessage`, body); }
  catch (e) { console.error('SEND ERR:', e.response?.data || e.message); }
};

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

const makeCall = async (phone, prompt) => {
  try {
    const n = phone.startsWith('+') ? phone : '+' + phone;
    console.log('Calling:', n, '| Prompt:', prompt.substring(0, 80));

    const r = await axios.post('https://api.vapi.ai/call', {
      phoneNumberId: VAPI_PHONE_ID,
      assistantId: VAPI_ASSISTANT_ID,
      assistantOverrides: {
        model: {
          provider: 'openai',
          model: 'gpt-4o',
          systemPrompt: prompt
        }
      },
      customer: { number: n }
    }, { headers: { Authorization: `Bearer ${VAPI_KEY}` } });

    console.log('Call started:', r.data?.id);
    return { ok: true, id: r.data.id };
  } catch (e) {
    console.error('Vapi err:', e.response?.data || e.message);
    return { ok: false, error: e.response?.data?.message || e.message };
  }
};

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  if (!req.body.message) return;
  const msg = req.body.message;
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const name = msg.from?.first_name || "do'st";
  const clean = p => p.replace(/[\s\-\(\)]/g, '');
  const phoneRe = /^\+?[0-9]{9,15}$/;

  if (['/start', '/menu'].includes(text)) {
    setS(chatId, { waitingFor: 'waiting_prompt', prompt: '', phone: '' });
    await send(chatId, `Assalomu alaykum, ${name}! 👋\n\nMen Call Center botman.\n\nNima qila olaman:\n• sizdan PROMPT qabul qilaman\n• sizdan telefon raqam qabul qilaman\n• ikkalasi tayyor bo'lsa Vapi orqali qo'ng'iroqni boshlayman\n\nPastdagi tugmalardan birini bosing:`, mainKb);
    return;
  }

  const s = getS(chatId);

  if (text === '🧠 Prompt') {
    setS(chatId, { ...s, waitingFor: 'waiting_prompt' });
    await send(chatId, '🧠 Prompt yuboring yoki 5 tayyor variantdan tanlang.', promptKb);
    return;
  }

  if (text === '📞 Nomer') {
    setS(chatId, { ...s, waitingFor: 'waiting_phone' });
    await send(chatId, '📞 Endi telefon raqam yuboring.\nFormat: +998901234567', rmKb);
    return;
  }

  const cp = clean(text);

  if (phoneRe.test(cp)) {
    if (!s.prompt) {
      setS(chatId, { ...s, phone: cp, waitingFor: 'waiting_prompt' });
      await send(chatId, `📞 Nomer saqlandi: ${cp}\n\n🧠 Endi prompt yuboring.`, promptKb);
      return;
    }
    await send(chatId, "⏳ Qo'ng'iroq boshlanmoqda...");
    const r = await makeCall(cp, s.prompt);
    setS(chatId, { waitingFor: 'waiting_prompt', prompt: '', phone: '' });
    await send(chatId,
      r.ok ? `✅ Qo'ng'iroq muvaffaqiyatli boshlandi!\n📞 ${cp} ga qo'ng'iroq ketmoqda...`
           : `❌ Qo'ng'iroq amalga oshmadi:\n${r.error}`,
      mainKb);
    return;
  }

  if (text.length >= 5) {
    setS(chatId, { ...s, prompt: text, waitingFor: 'waiting_phone' });
    await send(chatId, `✅ Prompt saqlandi!\n\n📞 Endi telefon raqam yuboring.\nFormat: +998901234567`, rmKb);
    return;
  }

  if (text.length > 0) await send(chatId, '❌ Prompt juda qisqa. Kamida 5 belgi kiriting.', promptKb);
});

app.get('/', (_, res) => res.json({ ok: true, assistant: VAPI_ASSISTANT_ID, phone: !!VAPI_PHONE_ID }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Server started on port', PORT);
  if (WEBHOOK_URL && BOT_TOKEN) {
    try {
      const r = await axios.post(`${TG}/setWebhook`, { url: WEBHOOK_URL + '/webhook', drop_pending_updates: true });
      console.log('Webhook set:', r.data.ok);
    } catch (e) { console.error('Webhook err:', e.message); }
  }
});
