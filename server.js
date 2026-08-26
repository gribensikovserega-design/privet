const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
const storage = require('node-persist');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация хранилища
storage.init({
    dir: 'data',
    stringify: JSON.stringify,
    parse: JSON.parse,
    encoding: 'utf8',
    logging: false
});

let usersDB = new Map();
let tags = new Set();
let onlineUsers = new Map();

// Загрузка данных при старте
async function loadData() {
    const users = await storage.getItem('users');
    if (users) {
        usersDB = new Map(Object.entries(users));
        usersDB.forEach((user) => {
            if (user.tag) {
                tags.add(user.tag);
            }
        });
    }
    console.log('Данные загружены');
}

// Сохранение данных
async function saveData() {
    const usersObj = Object.fromEntries(usersDB);
    await storage.setItem('users', usersObj);
    console.log('Данные сохранены');
}

loadData();

function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

app.post('/api/send-code', (req, res) => {
    const { phone } = req.body;
    
    if (!phone || phone.length < 10) {
        return res.status(400).json({ error: 'Введите корректный номер' });
    }
    
    const code = generateCode();
    
    if (!usersDB.has(phone)) {
        usersDB.set(phone, { 
            code, 
            verified: false,
            createdAt: Date.now()
        });
    } else {
        usersDB.get(phone).code = code;
    }
    
    saveData();
    
    console.log(`📱 Код для ${phone}: ${code}`);
    res.json({ success: true });
});

app.post('/api/verify-code', (req, res) => {
    const { phone, code } = req.body;
    
    if (!usersDB.has(phone)) {
        return res.status(400).json({ error: 'Пользователь не найден' });
    }
    
    const user = usersDB.get(phone);
    
    if (user.code !== code) {
        return res.status(400).json({ error: 'Неверный код' });
    }
    
    user.verified = true;
    saveData();
    
    // Если профиль уже заполнен - возвращаем данные
    if (user.firstName && user.tag) {
        return res.json({
            success: true,
            user: {
                phone,
                firstName: user.firstName,
                lastName: user.lastName,
                tag: user.tag,
                birthDate: user.birthDate,
                email: user.email,
                avatar: user.avatar
            },
            needProfile: false
        });
    }
    
    res.json({ success: true, needProfile: true });
});

app.post('/api/save-profile', (req, res) => {
    const { phone, firstName, lastName, tag, birthDate, email, avatar } = req.body;
    
    if (!usersDB.has(phone) || !usersDB.get(phone).verified) {
        return res.status(400).json({ error: 'Пользователь не авторизован' });
    }
    
    const cleanTag = tag.replace('@', '').toLowerCase();
    
    // Проверяем уникальность тега
    if (tags.has(cleanTag) && usersDB.get(phone).tag !== cleanTag) {
        return res.status(400).json({ error: 'Этот тег уже занят' });
    }
    
    // Удаляем старый тег
    const user = usersDB.get(phone);
    if (user.tag) {
        tags.delete(user.tag);
    }
    
    tags.add(cleanTag);
    
    user.firstName = firstName;
    user.lastName = lastName;
    user.tag = cleanTag;
    user.birthDate = birthDate;
    user.email = email;
    user.avatar = avatar;
    
    saveData();
    
    res.json({
        success: true,
        user: {
            phone,
            firstName,
            lastName,
            tag: cleanTag,
            birthDate,
            email,
            avatar
        }
    });
});

// API для получения всех пользователей
app.get('/api/get-users', (req, res) => {
    const users = [];
    usersDB.forEach((value, key) => {
        if (value.verified && value.firstName) {
            users.push({
                phone: key,
                firstName: value.firstName,
                lastName: value.lastName,
                tag: value.tag,
                avatar: value.avatar,
                email: value.email
            });
        }
    });
    res.json({ users });
});

// API для проверки авторизации
app.post('/api/check-auth', (req, res) => {
    const { phone } = req.body;
    
    if (!usersDB.has(phone)) {
        return res.json({ success: false });
    }
    
    const user = usersDB.get(phone);
    
    if (!user.verified) {
        return res.json({ success: false });
    }
    
    if (user.firstName && user.tag) {
        return res.json({
            success: true,
            user: {
                phone,
                firstName: user.firstName,
                lastName: user.lastName,
                tag: user.tag,
                birthDate: user.birthDate,
                email: user.email,
                avatar: user.avatar
            }
        });
    }
    
    res.json({ success: false });
});

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
            
            if (message.type === 'private_message') {
                const userInfo = onlineUsers.get(ws);
                
                if (!userInfo) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Сначала войдите' }));
                    return;
                }
                
                const newMessage = {
                    id: Date.now(),
                    phone: userInfo.phone,
                    userName: userInfo.name,
                    avatar: userInfo.avatar,
                    toPhone: message.toPhone,
                    text: message.text,
                    timestamp: new Date().toISOString()
                };
                
                onlineUsers.forEach((value, client) => {
                    if (value.phone === message.toPhone && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'private_message',
                            message: newMessage
                        }));
                    }
                });
                
                ws.send(JSON.stringify({
                    type: 'private_message',
                    message: newMessage
                }));
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
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

function broadcastUserList() {
    const userList = [];
    onlineUsers.forEach((value) => {
        userList.push({
            phone: value.phone,
            name: value.name,
            avatar: value.avatar
        });
    });
    
    broadcast({ type: 'users', users: userList });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});