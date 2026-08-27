const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = 'uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + Math.random().toString(36).substring(7) + path.extname(file.originalname));
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const SMS_API_ID = '80092059-6EB2-9425-83AF-59D4B555B8AE';

let usersDB = new Map();
let tags = new Set();
let onlineUsers = new Map();
let qrSessions = new Map();
let messagesDB = {};
let groupsDB = {}; // groupId -> { id, name, type: 'group'|'channel', creator, members: [], messages: [] }

function loadData() {
    try {
        if (fs.existsSync('data.json')) {
            const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
            if (data.users) {
                usersDB = new Map(Object.entries(data.users));
                usersDB.forEach((user) => { if (user.tag) tags.add(user.tag); });
            }
        }
        if (fs.existsSync('messages.json')) messagesDB = JSON.parse(fs.readFileSync('messages.json', 'utf8'));
        if (fs.existsSync('groups.json')) groupsDB = JSON.parse(fs.readFileSync('groups.json', 'utf8'));
        console.log('Данные загружены');
    } catch (error) {
        console.error('Ошибка загрузки:', error);
    }
}

function saveData() {
    try {
        fs.writeFileSync('data.json', JSON.stringify({ users: Object.fromEntries(usersDB) }, null, 2));
        fs.writeFileSync('messages.json', JSON.stringify(messagesDB, null, 2));
        fs.writeFileSync('groups.json', JSON.stringify(groupsDB, null, 2));
    } catch (error) {
        console.error('Ошибка сохранения:', error);
    }
}

loadData();

function generateCode() { return Math.floor(100000 + Math.random() * 900000).toString(); }
function generateQRToken() { return Math.random().toString(36).substring(2) + Date.now().toString(36); }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substring(2); }
function getChatKey(p1, p2) { return [p1, p2].sort().join('_'); }

async function sendSMS(phone, message) {
    try {
        const cleanPhone = phone.replace(/\D/g, '');
        const url = `https://sms.ru/sms/send?api_id=${SMS_API_ID}&to=${cleanPhone}&msg=${encodeURIComponent(message)}&json=1`;
        const response = await fetch(url);
        return await response.json();
    } catch (e) { return null; }
}

// ============ АВТОРИЗАЦИЯ ============
app.post('/api/upload-photo', upload.single('photo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    res.json({ success: true, url: '/uploads/' + req.file.filename });
});

app.post('/api/generate-qr', async (req, res) => {
    const qrToken = generateQRToken();
    qrSessions.set(qrToken, { status: 'pending', phone: null, createdAt: Date.now() });
    const qrImage = await QRCode.toDataURL(JSON.stringify({ token: qrToken, type: 'qr_login' }));
    res.json({ success: true, qrToken, qrImage });
});

app.post('/api/check-qr', (req, res) => {
    const { qrToken } = req.body;
    if (!qrSessions.has(qrToken)) return res.json({ status: 'expired' });
    const session = qrSessions.get(qrToken);
    if (session.status === 'confirmed' && session.phone) {
        const user = usersDB.get(session.phone);
        if (user && user.verified) {
            qrSessions.delete(qrToken);
            return res.json({ status: 'confirmed', user: { phone: session.phone, firstName: user.firstName, lastName: user.lastName, tag: user.tag, birthDate: user.birthDate, email: user.email, avatar: user.avatar } });
        }
    }
    if (Date.now() - session.createdAt > 120000) { qrSessions.delete(qrToken); return res.json({ status: 'expired' }); }
    res.json({ status: session.status });
});

app.post('/api/confirm-qr', (req, res) => {
    const { qrToken, phone } = req.body;
    if (!qrSessions.has(qrToken)) return res.status(400).json({ error: 'QR устарел' });
    if (!usersDB.has(phone) || !usersDB.get(phone).verified) return res.status(400).json({ error: 'Не авторизован' });
    qrSessions.get(qrToken).status = 'confirmed';
    qrSessions.get(qrToken).phone = phone;
    res.json({ success: true });
});

app.post('/api/send-code', async (req, res) => {
    const { phone } = req.body;
    if (!phone || phone.length < 10) return res.status(400).json({ error: 'Некорректный номер' });
    const code = generateCode();
    if (!usersDB.has(phone)) usersDB.set(phone, { code, verified: false, createdAt: Date.now() });
    else usersDB.get(phone).code = code;
    saveData();
    console.log(`📱 Код для ${phone}: ${code}`);
    try { await sendSMS(phone, `Ваш код: ${code}`); } catch(e) {}
    res.json({ success: true, code });
});

app.post('/api/verify-code', (req, res) => {
    const { phone, code } = req.body;
    if (!usersDB.has(phone)) return res.status(400).json({ error: 'Не найден' });
    const user = usersDB.get(phone);
    if (user.code !== code) return res.status(400).json({ error: 'Неверный код' });
    user.verified = true;
    saveData();
    if (user.firstName && user.tag && user.password) {
        return res.json({ success: true, user: { phone, firstName: user.firstName, lastName: user.lastName, tag: user.tag, birthDate: user.birthDate, email: user.email, avatar: user.avatar }, needProfile: false });
    }
    res.json({ success: true, needProfile: true });
});

app.post('/api/save-profile', (req, res) => {
    const { phone, firstName, lastName, tag, birthDate, email, avatar, password } = req.body;
    if (!usersDB.has(phone) || !usersDB.get(phone).verified) return res.status(400).json({ error: 'Не авторизован' });
    const cleanTag = tag.replace('@', '').toLowerCase();
    if (tags.has(cleanTag) && usersDB.get(phone).tag !== cleanTag) return res.status(400).json({ error: 'Тег занят' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль мин 6' });
    const user = usersDB.get(phone);
    if (user.tag) tags.delete(user.tag);
    tags.add(cleanTag);
    user.firstName = firstName; user.lastName = lastName; user.tag = cleanTag;
    user.birthDate = birthDate; user.email = email; user.avatar = avatar; user.password = password;
    saveData();
    res.json({ success: true, user: { phone, firstName, lastName, tag: cleanTag, birthDate, email, avatar } });
});

app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Введите данные' });
    const cleanLogin = login.trim().toLowerCase();
    let foundUser = null, foundPhone = null;
    usersDB.forEach((user, phone) => {
        if (!user.password) return;
        if (cleanLogin === (user.tag || '').toLowerCase() || cleanLogin === (user.email || '').toLowerCase() || cleanLogin === phone || cleanLogin === phone.replace(/\D/g, '')) {
            foundUser = user; foundPhone = phone;
        }
    });
    if (!foundUser) return res.status(400).json({ error: 'Не найден' });
    if (foundUser.password !== password) return res.status(400).json({ error: 'Неверный пароль' });
    res.json({ success: true, user: { phone: foundPhone, firstName: foundUser.firstName, lastName: foundUser.lastName, tag: foundUser.tag, birthDate: foundUser.birthDate, email: foundUser.email, avatar: foundUser.avatar } });
});

app.get('/api/get-users', (req, res) => {
    const users = [];
    usersDB.forEach((value, key) => {
        if (value.verified) users.push({ phone: key, firstName: value.firstName || 'Пользователь', lastName: value.lastName || '', tag: value.tag || '', avatar: value.avatar || null, email: value.email || '' });
    });
    res.json({ users });
});

app.post('/api/check-auth', (req, res) => {
    const { phone } = req.body;
    if (!usersDB.has(phone)) return res.json({ success: false });
    const user = usersDB.get(phone);
    if (!user.verified) return res.json({ success: false });
    if (user.firstName && user.tag) return res.json({ success: true, user: { phone, firstName: user.firstName, lastName: user.lastName, tag: user.tag, birthDate: user.birthDate, email: user.email, avatar: user.avatar } });
    res.json({ success: false });
});

app.post('/api/get-messages', (req, res) => {
    const { phone1, phone2 } = req.body;
    res.json({ messages: messagesDB[getChatKey(phone1, phone2)] || [] });
});

// ============ ГРУППЫ И КАНАЛЫ ============
app.post('/api/create-group', (req, res) => {
    const { phone, name, type } = req.body;
    if (!usersDB.has(phone) || !usersDB.get(phone).verified) return res.status(400).json({ error: 'Не авторизован' });
    
    const groupId = generateId();
    groupsDB[groupId] = {
        id: groupId,
        name,
        type: type || 'group', // 'group' или 'channel'
        creator: phone,
        members: [phone],
        messages: [],
        createdAt: Date.now()
    };
    saveData();
    
    res.json({ success: true, group: groupsDB[groupId] });
});

app.get('/api/get-groups', (req, res) => {
    const groups = Object.values(groupsDB);
    res.json({ groups });
});

app.post('/api/join-group', (req, res) => {
    const { phone, groupId } = req.body;
    if (!groupsDB[groupId]) return res.status(400).json({ error: 'Группа не найдена' });
    if (!groupsDB[groupId].members.includes(phone)) {
        groupsDB[groupId].members.push(phone);
        saveData();
    }
    res.json({ success: true, group: groupsDB[groupId] });
});

app.post('/api/get-group-messages', (req, res) => {
    const { groupId } = req.body;
    if (!groupsDB[groupId]) return res.status(400).json({ error: 'Не найдено' });
    res.json({ messages: groupsDB[groupId].messages || [] });
});

// ============ WEBSOCKET ============
wss.on('connection', (ws) => {
    console.log('Новое подключение');
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'join') {
                const { phone, name, avatar } = message;
                if (!usersDB.has(phone) || !usersDB.get(phone).verified) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Не авторизован' }));
                    return;
                }
                onlineUsers.set(ws, { phone, name, avatar });
                broadcastUserList();
                return;
            }
            
            if (message.type === 'typing') {
                const userInfo = onlineUsers.get(ws);
                if (!userInfo) return;
                onlineUsers.forEach((value, client) => {
                    if (value.phone === message.toPhone && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'typing', fromPhone: userInfo.phone, userName: userInfo.name, isTyping: message.isTyping }));
                    }
                });
                return;
            }
            
            if (message.type === 'private_message') {
                const userInfo = onlineUsers.get(ws);
                if (!userInfo) return;
                const newMessage = { id: Date.now(), phone: userInfo.phone, userName: userInfo.name, avatar: userInfo.avatar, toPhone: message.toPhone, text: message.text || '', photo: message.photo || null, timestamp: new Date().toISOString(), reactions: {}, edited: false };
                const chatKey = getChatKey(userInfo.phone, message.toPhone);
                if (!messagesDB[chatKey]) messagesDB[chatKey] = [];
                messagesDB[chatKey].push(newMessage);
                saveData();
                onlineUsers.forEach((value, client) => {
                    if (value.phone === message.toPhone && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'private_message', message: newMessage }));
                });
                ws.send(JSON.stringify({ type: 'private_message', message: newMessage }));
                return;
            }
            
            if (message.type === 'group_message') {
                const userInfo = onlineUsers.get(ws);
                if (!userInfo) return;
                const group = groupsDB[message.groupId];
                if (!group) return;
                
                const newMessage = { id: Date.now(), phone: userInfo.phone, userName: userInfo.name, avatar: userInfo.avatar, groupId: message.groupId, text: message.text || '', photo: message.photo || null, timestamp: new Date().toISOString(), reactions: {} };
                group.messages.push(newMessage);
                saveData();
                
                // Отправляем всем участникам
                onlineUsers.forEach((value, client) => {
                    if (group.members.includes(value.phone) && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'group_message', message: newMessage }));
                    }
                });
                return;
            }
            
            if (message.type === 'delete_message') {
                const userInfo = onlineUsers.get(ws);
                if (!userInfo) return;
                const chatKey = getChatKey(userInfo.phone, message.toPhone);
                if (messagesDB[chatKey]) {
                    messagesDB[chatKey] = messagesDB[chatKey].filter(m => m.id !== message.messageId);
                    saveData();
                }
                const deleteData = { type: 'message_deleted', messageId: message.messageId, toPhone: message.toPhone, fromPhone: userInfo.phone };
                onlineUsers.forEach((value, client) => {
                    if ((value.phone === message.toPhone || value.phone === userInfo.phone) && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(deleteData));
                });
                return;
            }
            
            if (message.type === 'edit_message') {
                const userInfo = onlineUsers.get(ws);
                if (!userInfo) return;
                const chatKey = getChatKey(userInfo.phone, message.toPhone);
                if (messagesDB[chatKey]) {
                    const msg = messagesDB[chatKey].find(m => m.id === message.messageId);
                    if (msg) { msg.text = message.newText; msg.edited = true; saveData(); }
                }
                const editData = { type: 'message_edited', messageId: message.messageId, newText: message.newText, toPhone: message.toPhone, fromPhone: userInfo.phone };
                onlineUsers.forEach((value, client) => {
                    if ((value.phone === message.toPhone || value.phone === userInfo.phone) && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(editData));
                });
                return;
            }
            
            if (message.type === 'reaction') {
                const userInfo = onlineUsers.get(ws);
                if (!userInfo) return;
                const chatKey = getChatKey(userInfo.phone, message.toPhone);
                if (messagesDB[chatKey]) {
                    const msg = messagesDB[chatKey].find(m => m.id === message.messageId);
                    if (msg) { msg.reactions[userInfo.phone] = message.emoji; saveData(); }
                }
                const reactionData = { type: 'message_reaction', messageId: message.messageId, emoji: message.emoji, fromPhone: userInfo.phone, toPhone: message.toPhone };
                onlineUsers.forEach((value, client) => {
                    if ((value.phone === message.toPhone || value.phone === userInfo.phone) && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(reactionData));
                });
            }
        } catch (error) {
            console.error('Ошибка:', error);
        }
    });
    
    ws.on('close', () => {
        onlineUsers.delete(ws);
        broadcastUserList();
    });
});

function broadcast(data) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
    });
}

function broadcastUserList() {
    const userList = [];
    onlineUsers.forEach((value) => {
        userList.push({ phone: value.phone, name: value.name, avatar: value.avatar, online: true });
    });
    broadcast({ type: 'users', users: userList });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});