
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs-extra');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Configuração
const PORT = process.env.PORT || 5000;
const MUSIC_DIR = path.join(__dirname, 'public', 'music');
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');

// Garantir que os diretórios existam
fs.ensureDirSync(MUSIC_DIR);
fs.ensureDirSync(UPLOAD_DIR);

// Configuração do multer para upload de arquivos
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        const allowedTypes = /mp3|wav|ogg|m4a/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Apenas arquivos de áudio são permitidos!'));
        }
    }
});

// Middleware
app.use(express.static('public'));
app.use(express.json());

// Estado da aplicação
let playlist = [];
let currentSongIndex = 0;
let isPlaying = false;
let chatMessages = [];
let musicRequests = [];
let bannedUsers = [];
let isShuffleEnabled = false;
let isRepeatEnabled = false;
let playMode = 'normal'; // normal, shuffle, repeat

// Sistema de usuários e perfis
let registeredUsers = new Map(); // userId -> { id, username, email, avatar, bio, joinDate, totalListeningTime, favoriteSongs, friends, genre }
let userSessions = new Map(); // socketId -> userId
let userProfiles = new Map(); // userId -> { preferences, socialLinks, isOnline, lastSeen }

// Sistema de salas de chat temáticas
let chatRooms = new Map(); // roomId -> { id, name, genre, users, messages, description }
let roomMessages = new Map(); // roomId -> messages[]

// Sistema de amigos
let friendRequests = new Map(); // userId -> [{ from, to, status, timestamp }]
let friendsList = new Map(); // userId -> [friendIds]

// Sistema de comentários nas músicas
let songComments = new Map(); // songId -> [{ id, userId, username, comment, timestamp, likes }]

// Sistema de Gamificação
let userPoints = new Map(); // userId -> { totalPoints, dailyPoints, weeklyPoints, activities }
let userBadges = new Map(); // userId -> [{ id, name, description, earnedAt, type }]
let leaderboard = new Map(); // period -> [{ userId, username, points, position }]
let specialEvents = new Map(); // eventId -> { id, name, description, startDate, endDate, type, rewards, participants }
let userActivities = new Map(); // userId -> [{ type, timestamp, points, details }]

// Definição de badges disponíveis
const availableBadges = [
    { id: 'first_login', name: '🎵 Primeiro Acesso', description: 'Bem-vindo à WebRadio!', points: 10, type: 'milestone' },
    { id: 'chat_rookie', name: '💬 Tagarela Iniciante', description: 'Enviou 10 mensagens no chat', points: 20, type: 'social' },
    { id: 'chat_veteran', name: '💬 Veterano do Chat', description: 'Enviou 100 mensagens no chat', points: 50, type: 'social' },
    { id: 'music_lover', name: '🎶 Amante da Música', description: 'Ouviu 50 músicas completas', points: 30, type: 'listening' },
    { id: 'dedicated_listener', name: '🎧 Ouvinte Dedicado', description: 'Passou 5 horas ouvindo', points: 75, type: 'listening' },
    { id: 'social_butterfly', name: '🦋 Borboleta Social', description: 'Adicionou 5 amigos', points: 40, type: 'social' },
    { id: 'commenter', name: '💭 Comentarista', description: 'Fez 25 comentários em músicas', points: 35, type: 'engagement' },
    { id: 'early_bird', name: '🌅 Madrugador', description: 'Ouviu música entre 5h e 7h', points: 25, type: 'special' },
    { id: 'night_owl', name: '🦉 Coruja Noturna', description: 'Ouviu música entre 23h e 1h', points: 25, type: 'special' },
    { id: 'weekend_warrior', name: '🏖️ Guerreiro do Fim de Semana', description: 'Ativo nos fins de semana', points: 30, type: 'special' },
    { id: 'loyal_fan', name: '⭐ Fã Fiel', description: '30 dias consecutivos ouvindo', points: 100, type: 'milestone' },
    { id: 'request_master', name: '🎵 Mestre dos Pedidos', description: 'Fez 20 pedidos musicais', points: 45, type: 'engagement' },
    { id: 'genre_explorer', name: '🗺️ Explorador Musical', description: 'Visitou todas as salas de gênero', points: 60, type: 'exploration' },
    { id: 'like_giver', name: '❤️ Coração Generoso', description: 'Curtiu 100 comentários', points: 40, type: 'social' },
    { id: 'daily_visitor', name: '📅 Visitante Diário', description: 'Visitou a rádio por 7 dias seguidos', points: 80, type: 'milestone' }
];

// Tipos de pontos por atividade
const pointsSystem = {
    chat_message: 2,
    music_request: 3,
    song_listen_complete: 5,
    add_friend: 10,
    song_comment: 5,
    comment_like: 1,
    daily_login: 10,
    room_visit: 2,
    share_song: 8,
    event_participation: 20,
    listening_time_hour: 15 // por hora de escuta
};

// Inicializar salas de chat por gênero
function initializeChatRooms() {
    const genres = [
        { id: 'pop', name: 'Pop', description: 'Música pop e hits atuais' },
        { id: 'rock', name: 'Rock', description: 'Rock clássico e moderno' },
        { id: 'eletronica', name: 'Eletrônica', description: 'EDM, house, techno' },
        { id: 'mpb', name: 'MPB', description: 'Música Popular Brasileira' },
        { id: 'internacional', name: 'Internacional', description: 'Hits internacionais' },
        { id: 'geral', name: 'Geral', description: 'Conversa geral sobre música' }
    ];

    genres.forEach(genre => {
        chatRooms.set(genre.id, {
            id: genre.id,
            name: genre.name,
            genre: genre.id,
            users: new Set(),
            description: genre.description,
            createdAt: new Date().toISOString()
        });
        roomMessages.set(genre.id, []);
    });
}

// Sistema de estatísticas e analytics
let connectedListeners = new Map(); // socketId -> { username, connectedAt, totalListeningTime, currentSessionStart }
let songStats = new Map(); // songId -> { playCount, totalListeningTime, listeners }
let dailyStats = new Map(); // date -> { uniqueListeners, totalListeningTime, songsPlayed }
let listenerSessions = []; // histórico de sessões de ouvintes

// Estado do broadcast
let isLiveStreaming = false;
let currentProgram = null;
let scheduledPrograms = [];
let jingles = [];
let notifications = [];
let autoJingleInterval = null;
let programScheduler = null;

// Carregar playlist inicial
function loadInitialPlaylist() {
    try {
        const musicFiles = fs.readdirSync(MUSIC_DIR).filter(file => 
            /\.(mp3|wav|ogg|m4a)$/i.test(file)
        );
        
        playlist = musicFiles.map((file, index) => ({
            id: index + 1,
            name: file.replace(/\.[^/.]+$/, ""),
            filename: file,
            path: `/music/${file}`
        }));
    } catch (error) {
        console.log('Nenhum arquivo de música encontrado no diretório');
    }
}

// Inicializar playlist
loadInitialPlaylist();

// Inicializar salas de chat
initializeChatRooms();

// Funções de broadcast
function schedulePrograms() {
    if (programScheduler) {
        clearInterval(programScheduler);
    }
    
    programScheduler = setInterval(() => {
        const now = new Date();
        const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        const currentDay = now.getDay();
        
        scheduledPrograms.forEach(program => {
            if (!program.isActive) return;
            
            let shouldStart = false;
            
            if (program.isRecurring) {
                shouldStart = program.daysOfWeek.includes(currentDay) && program.startTime === currentTime;
            } else {
                // Para programas únicos, verificar se é hoje
                const programDate = new Date(program.startTime);
                shouldStart = programDate.toDateString() === now.toDateString() && 
                             programDate.getHours() === now.getHours() && 
                             programDate.getMinutes() === now.getMinutes();
            }
            
            if (shouldStart && (!currentProgram || currentProgram.id !== program.id)) {
                startProgram(program);
            }
        });
        
        // Verificar se programa atual deve terminar
        if (currentProgram) {
            const programStart = new Date();
            const [hours, minutes] = currentProgram.startTime.split(':');
            programStart.setHours(hours, minutes, 0, 0);
            
            const programEnd = new Date(programStart.getTime() + (currentProgram.duration * 60000));
            
            if (now >= programEnd) {
                endProgram();
            }
        }
    }, 60000); // Verificar a cada minuto
}

function startProgram(program) {
    currentProgram = program;
    
    const startMessage = {
        id: Date.now().toString(),
        username: 'Sistema',
        message: `📻 PROGRAMA INICIADO: ${program.title}`,
        timestamp: new Date().toLocaleTimeString(),
        type: 'system'
    };
    
    chatMessages.push(startMessage);
    io.emit('newMessage', startMessage);
    io.emit('programStarted', program);
    
    // Notificação especial para início de programa
    const notification = {
        id: Date.now().toString(),
        title: 'Programa ao Vivo',
        message: `${program.title} começou agora!`,
        type: 'program',
        isImmediate: true
    };
    
    sendNotification(notification);
}

function endProgram() {
    if (currentProgram) {
        const endMessage = {
            id: Date.now().toString(),
            username: 'Sistema',
            message: `📻 Programa "${currentProgram.title}" encerrado`,
            timestamp: new Date().toLocaleTimeString(),
            type: 'system'
        };
        
        chatMessages.push(endMessage);
        io.emit('newMessage', endMessage);
        io.emit('programEnded', currentProgram);
        
        currentProgram = null;
    }
}

function getNextProgram() {
    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();
    const currentDay = now.getDay();
    
    let nextProgram = null;
    let minTimeDiff = Infinity;
    
    scheduledPrograms.forEach(program => {
        if (!program.isActive) return;
        
        if (program.isRecurring) {
            program.daysOfWeek.forEach(day => {
                const [hours, minutes] = program.startTime.split(':');
                const programTime = parseInt(hours) * 60 + parseInt(minutes);
                
                let timeDiff;
                if (day === currentDay && programTime > currentTime) {
                    timeDiff = programTime - currentTime;
                } else if (day > currentDay) {
                    timeDiff = (day - currentDay) * 24 * 60 + programTime - currentTime;
                } else {
                    timeDiff = (7 - currentDay + day) * 24 * 60 + programTime - currentTime;
                }
                
                if (timeDiff < minTimeDiff) {
                    minTimeDiff = timeDiff;
                    nextProgram = { ...program, nextStart: timeDiff };
                }
            });
        }
    });
    
    return nextProgram;
}

function setupAutoJingles() {
    if (autoJingleInterval) {
        clearInterval(autoJingleInterval);
    }
    
    const activeJingles = jingles.filter(j => j.isActive && j.type === 'station');
    
    if (activeJingles.length > 0) {
        autoJingleInterval = setInterval(() => {
            if (!isLiveStreaming && isPlaying) {
                const availableJingles = activeJingles.filter(j => {
                    if (!j.lastPlayed) return true;
                    
                    const timeSinceLastPlayed = Date.now() - new Date(j.lastPlayed).getTime();
                    const intervalMs = j.intervalMinutes * 60 * 1000;
                    
                    return timeSinceLastPlayed >= intervalMs;
                });
                
                if (availableJingles.length > 0) {
                    const randomJingle = availableJingles[Math.floor(Math.random() * availableJingles.length)];
                    
                    randomJingle.lastPlayed = new Date();
                    io.emit('playJingle', randomJingle);
                    
                    const jingleMessage = {
                        id: Date.now().toString(),
                        username: 'Sistema',
                        message: `🎵 ${randomJingle.name}`,
                        timestamp: new Date().toLocaleTimeString(),
                        type: 'system'
                    };
                    
                    chatMessages.push(jingleMessage);
                    io.emit('newMessage', jingleMessage);
                }
            }
        }, 5 * 60 * 1000); // Verificar a cada 5 minutos
    }
}

function sendNotification(notification) {
    notification.sent = true;
    notification.sentAt = new Date().toISOString();
    
    const notificationMessage = {
        id: Date.now().toString(),
        username: 'Sistema',
        message: `📢 ${notification.title}: ${notification.message}`,
        timestamp: new Date().toLocaleTimeString(),
        type: 'system'
    };
    
    chatMessages.push(notificationMessage);
    io.emit('newMessage', notificationMessage);
    io.emit('specialNotification', notification);
}

function scheduleNotification(notification) {
    const now = new Date();
    const scheduledTime = new Date(notification.scheduledTime);
    const delay = scheduledTime.getTime() - now.getTime();
    
    if (delay > 0) {
        setTimeout(() => {
            if (!notification.sent) {
                sendNotification(notification);
            }
        }, delay);
    }
}

// Funções de analytics
function updateListenerStats(socketId, action, data = {}) {
    const today = new Date().toISOString().split('T')[0];
    
    switch (action) {
        case 'connect':
            connectedListeners.set(socketId, {
                username: data.username || 'Anônimo',
                connectedAt: Date.now(),
                totalListeningTime: 0,
                currentSessionStart: Date.now(),
                songsListened: new Set()
            });
            
            if (!dailyStats.has(today)) {
                dailyStats.set(today, {
                    uniqueListeners: new Set(),
                    totalListeningTime: 0,
                    songsPlayed: new Set()
                });
            }
            dailyStats.get(today).uniqueListeners.add(socketId);
            break;
            
        case 'disconnect':
            const listener = connectedListeners.get(socketId);
            if (listener) {
                const sessionTime = Date.now() - listener.currentSessionStart;
                listener.totalListeningTime += sessionTime;
                
                // Salvar sessão no histórico
                listenerSessions.push({
                    id: Date.now().toString(),
                    username: listener.username,
                    connectedAt: listener.connectedAt,
                    disconnectedAt: Date.now(),
                    totalTime: listener.totalListeningTime,
                    songsListened: Array.from(listener.songsListened),
                    date: today
                });
                
                // Atualizar stats diárias
                if (dailyStats.has(today)) {
                    dailyStats.get(today).totalListeningTime += sessionTime;
                }
                
                connectedListeners.delete(socketId);
                
                // Manter apenas últimas 1000 sessões
                if (listenerSessions.length > 1000) {
                    listenerSessions = listenerSessions.slice(-1000);
                }
            }
            break;
            
        case 'songPlay':
            const currentSong = playlist[currentSongIndex];
            if (currentSong) {
                if (!songStats.has(currentSong.id)) {
                    songStats.set(currentSong.id, {
                        id: currentSong.id,
                        name: currentSong.name,
                        playCount: 0,
                        totalListeningTime: 0,
                        listeners: new Set()
                    });
                }
                
                const stats = songStats.get(currentSong.id);
                stats.playCount++;
                
                // Adicionar música às stats diárias
                if (dailyStats.has(today)) {
                    dailyStats.get(today).songsPlayed.add(currentSong.id);
                }
                
                // Marcar que todos os ouvintes conectados estão ouvindo esta música
                connectedListeners.forEach((listener, id) => {
                    stats.listeners.add(id);
                    listener.songsListened.add(currentSong.id);
                });
            }
            break;
    }
}

function getAnalyticsData() {
    const currentSong = playlist[currentSongIndex];
    const today = new Date().toISOString().split('T')[0];
    
    // Ouvintes simultâneos
    const simultaneousListeners = connectedListeners.size;
    
    // Músicas mais tocadas (top 10)
    const topSongs = Array.from(songStats.values())
        .sort((a, b) => b.playCount - a.playCount)
        .slice(0, 10)
        .map(song => ({
            id: song.id,
            name: song.name,
            playCount: song.playCount,
            totalListeningTime: Math.round(song.totalListeningTime / 1000 / 60), // em minutos
            currentListeners: song.listeners.size
        }));
    
    // Tempo de escuta por usuário (usuários ativos)
    const activeListeners = Array.from(connectedListeners.entries()).map(([socketId, listener]) => {
        const currentSessionTime = Date.now() - listener.currentSessionStart;
        return {
            username: listener.username,
            totalTime: Math.round((listener.totalListeningTime + currentSessionTime) / 1000 / 60), // em minutos
            songsListened: listener.songsListened.size,
            connectedSince: new Date(listener.connectedAt).toLocaleTimeString()
        };
    });
    
    // Relatórios de audiência (últimos 7 dias)
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        
        const dayStats = dailyStats.get(dateStr) || {
            uniqueListeners: new Set(),
            totalListeningTime: 0,
            songsPlayed: new Set()
        };
        
        last7Days.push({
            date: dateStr,
            uniqueListeners: dayStats.uniqueListeners.size,
            totalListeningTime: Math.round(dayStats.totalListeningTime / 1000 / 60), // em minutos
            songsPlayed: dayStats.songsPlayed.size,
            avgListeningTime: dayStats.uniqueListeners.size > 0 ? 
                Math.round(dayStats.totalListeningTime / dayStats.uniqueListeners.size / 1000 / 60) : 0
        });
    }
    
    // Estatísticas gerais
    const totalSessions = listenerSessions.length;
    const avgSessionTime = totalSessions > 0 ? 
        Math.round(listenerSessions.reduce((sum, session) => sum + session.totalTime, 0) / totalSessions / 1000 / 60) : 0;
    
    return {
        simultaneousListeners,
        topSongs,
        activeListeners,
        audienceReports: last7Days,
        generalStats: {
            totalSongs: playlist.length,
            totalSessions,
            avgSessionTime,
            currentSong: currentSong ? {
                name: currentSong.name,
                currentListeners: simultaneousListeners,
                playCount: songStats.has(currentSong.id) ? songStats.get(currentSong.id).playCount : 0
            } : null
        }
    };
}

// Funções de Gamificação
function initializeUserPoints(userId) {
    if (!userPoints.has(userId)) {
        userPoints.set(userId, {
            totalPoints: 0,
            dailyPoints: 0,
            weeklyPoints: 0,
            lastLoginDate: null,
            consecutiveDays: 0,
            activities: []
        });
    }
    
    if (!userBadges.has(userId)) {
        userBadges.set(userId, []);
    }
    
    if (!userActivities.has(userId)) {
        userActivities.set(userId, []);
    }
}

function addUserPoints(userId, activityType, details = {}) {
    initializeUserPoints(userId);
    
    const points = pointsSystem[activityType] || 0;
    const userPointsData = userPoints.get(userId);
    
    userPointsData.totalPoints += points;
    userPointsData.dailyPoints += points;
    userPointsData.weeklyPoints += points;
    
    // Registrar atividade
    const activity = {
        type: activityType,
        timestamp: new Date().toISOString(),
        points,
        details
    };
    
    userActivities.get(userId).push(activity);
    userPointsData.activities.push(activity);
    
    // Manter apenas últimas 100 atividades
    if (userActivities.get(userId).length > 100) {
        userActivities.set(userId, userActivities.get(userId).slice(-100));
    }
    
    // Verificar badges
    checkAndAwardBadges(userId);
    
    // Atualizar leaderboard
    updateLeaderboard();
    
    // Notificar usuário sobre pontos ganhos
    const user = registeredUsers.get(userId);
    if (user) {
        io.emit('pointsEarned', {
            userId,
            points,
            activityType,
            totalPoints: userPointsData.totalPoints,
            message: `+${points} pontos por ${getActivityDescription(activityType)}`
        });
    }
}

function getActivityDescription(activityType) {
    const descriptions = {
        chat_message: 'enviar mensagem',
        music_request: 'fazer pedido musical',
        song_listen_complete: 'ouvir música completa',
        add_friend: 'adicionar amigo',
        song_comment: 'comentar música',
        comment_like: 'curtir comentário',
        daily_login: 'login diário',
        room_visit: 'visitar sala',
        share_song: 'compartilhar música',
        event_participation: 'participar de evento',
        listening_time_hour: 'hora de escuta'
    };
    
    return descriptions[activityType] || activityType;
}

function checkAndAwardBadges(userId) {
    initializeUserPoints(userId);
    
    const userPointsData = userPoints.get(userId);
    const userBadgesList = userBadges.get(userId);
    const userActivitiesList = userActivities.get(userId);
    const user = registeredUsers.get(userId);
    
    if (!user) return;
    
    availableBadges.forEach(badge => {
        // Verificar se já possui o badge
        if (userBadgesList.some(b => b.id === badge.id)) return;
        
        let shouldAward = false;
        
        switch (badge.id) {
            case 'first_login':
                shouldAward = true;
                break;
                
            case 'chat_rookie':
                const chatMessages = userActivitiesList.filter(a => a.type === 'chat_message').length;
                shouldAward = chatMessages >= 10;
                break;
                
            case 'chat_veteran':
                const totalChatMessages = userActivitiesList.filter(a => a.type === 'chat_message').length;
                shouldAward = totalChatMessages >= 100;
                break;
                
            case 'music_lover':
                const completeSongs = userActivitiesList.filter(a => a.type === 'song_listen_complete').length;
                shouldAward = completeSongs >= 50;
                break;
                
            case 'dedicated_listener':
                const listeningHours = userActivitiesList.filter(a => a.type === 'listening_time_hour').length;
                shouldAward = listeningHours >= 5;
                break;
                
            case 'social_butterfly':
                const friendsAdded = userActivitiesList.filter(a => a.type === 'add_friend').length;
                shouldAward = friendsAdded >= 5;
                break;
                
            case 'commenter':
                const comments = userActivitiesList.filter(a => a.type === 'song_comment').length;
                shouldAward = comments >= 25;
                break;
                
            case 'early_bird':
                const earlyActivities = userActivitiesList.filter(a => {
                    const hour = new Date(a.timestamp).getHours();
                    return hour >= 5 && hour <= 7;
                });
                shouldAward = earlyActivities.length >= 5;
                break;
                
            case 'night_owl':
                const nightActivities = userActivitiesList.filter(a => {
                    const hour = new Date(a.timestamp).getHours();
                    return hour >= 23 || hour <= 1;
                });
                shouldAward = nightActivities.length >= 5;
                break;
                
            case 'request_master':
                const requests = userActivitiesList.filter(a => a.type === 'music_request').length;
                shouldAward = requests >= 20;
                break;
                
            case 'like_giver':
                const likes = userActivitiesList.filter(a => a.type === 'comment_like').length;
                shouldAward = likes >= 100;
                break;
                
            case 'daily_visitor':
                shouldAward = userPointsData.consecutiveDays >= 7;
                break;
                
            case 'loyal_fan':
                shouldAward = userPointsData.consecutiveDays >= 30;
                break;
        }
        
        if (shouldAward) {
            awardBadge(userId, badge);
        }
    });
}

function awardBadge(userId, badge) {
    const userBadgesList = userBadges.get(userId);
    const user = registeredUsers.get(userId);
    
    const earnedBadge = {
        ...badge,
        earnedAt: new Date().toISOString()
    };
    
    userBadgesList.push(earnedBadge);
    
    // Adicionar pontos do badge
    if (badge.points) {
        const userPointsData = userPoints.get(userId);
        userPointsData.totalPoints += badge.points;
        userPointsData.dailyPoints += badge.points;
        userPointsData.weeklyPoints += badge.points;
    }
    
    // Notificar usuário
    io.emit('badgeEarned', {
        userId,
        badge: earnedBadge,
        message: `Parabéns! Você ganhou o badge "${badge.name}"`
    });
    
    // Mensagem no chat
    const badgeMessage = {
        id: Date.now().toString(),
        username: 'Sistema',
        message: `🏆 ${user.username} ganhou o badge "${badge.name}"!`,
        timestamp: new Date().toLocaleTimeString(),
        type: 'system'
    };
    
    chatMessages.push(badgeMessage);
    io.emit('newMessage', badgeMessage);
}

function updateLeaderboard() {
    const dailyLeaderboard = [];
    const weeklyLeaderboard = [];
    const allTimeLeaderboard = [];
    
    for (const [userId, pointsData] of userPoints.entries()) {
        const user = registeredUsers.get(userId);
        if (!user) continue;
        
        dailyLeaderboard.push({
            userId,
            username: user.username,
            avatar: user.avatar,
            points: pointsData.dailyPoints,
            totalPoints: pointsData.totalPoints
        });
        
        weeklyLeaderboard.push({
            userId,
            username: user.username,
            avatar: user.avatar,
            points: pointsData.weeklyPoints,
            totalPoints: pointsData.totalPoints
        });
        
        allTimeLeaderboard.push({
            userId,
            username: user.username,
            avatar: user.avatar,
            points: pointsData.totalPoints,
            totalPoints: pointsData.totalPoints
        });
    }
    
    // Ordenar e adicionar posições
    const sortAndRank = (leaderboard) => {
        return leaderboard
            .sort((a, b) => b.points - a.points)
            .map((entry, index) => ({ ...entry, position: index + 1 }))
            .slice(0, 20); // Top 20
    };
    
    leaderboard.set('daily', sortAndRank(dailyLeaderboard));
    leaderboard.set('weekly', sortAndRank(weeklyLeaderboard));
    leaderboard.set('alltime', sortAndRank(allTimeLeaderboard));
}

function checkDailyLogin(userId) {
    initializeUserPoints(userId);
    
    const userPointsData = userPoints.get(userId);
    const today = new Date().toDateString();
    const lastLogin = userPointsData.lastLoginDate;
    
    if (lastLogin !== today) {
        // Novo dia
        userPointsData.lastLoginDate = today;
        
        if (lastLogin) {
            const lastDate = new Date(lastLogin);
            const currentDate = new Date(today);
            const timeDiff = currentDate.getTime() - lastDate.getTime();
            const dayDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));
            
            if (dayDiff === 1) {
                // Dia consecutivo
                userPointsData.consecutiveDays++;
            } else {
                // Quebrou a sequência
                userPointsData.consecutiveDays = 1;
            }
        } else {
            userPointsData.consecutiveDays = 1;
        }
        
        // Resetar pontos diários
        userPointsData.dailyPoints = 0;
        
        // Dar pontos de login diário
        addUserPoints(userId, 'daily_login', { consecutiveDays: userPointsData.consecutiveDays });
    }
}

function createSpecialEvent(eventData) {
    const event = {
        id: Date.now().toString(),
        ...eventData,
        participants: new Set(),
        createdAt: new Date().toISOString()
    };
    
    specialEvents.set(event.id, event);
    
    // Notificar todos os usuários
    const eventMessage = {
        id: Date.now().toString(),
        username: 'Sistema',
        message: `🎉 EVENTO ESPECIAL: ${event.name} - ${event.description}`,
        timestamp: new Date().toLocaleTimeString(),
        type: 'system'
    };
    
    chatMessages.push(eventMessage);
    io.emit('newMessage', eventMessage);
    io.emit('specialEventStarted', event);
    
    return event;
}

function joinSpecialEvent(userId, eventId) {
    const event = specialEvents.get(eventId);
    const user = registeredUsers.get(userId);
    
    if (!event || !user) return false;
    
    const now = new Date();
    const startDate = new Date(event.startDate);
    const endDate = new Date(event.endDate);
    
    if (now < startDate || now > endDate) return false;
    
    event.participants.add(userId);
    addUserPoints(userId, 'event_participation', { eventId, eventName: event.name });
    
    return true;
}

function resetWeeklyStats() {
    for (const [userId, pointsData] of userPoints.entries()) {
        pointsData.weeklyPoints = 0;
    }
    updateLeaderboard();
}

// Inicializar sistemas de broadcast
schedulePrograms();
setupAutoJingles();

// Resetar estatísticas semanais todo domingo
setInterval(() => {
    const now = new Date();
    if (now.getDay() === 0 && now.getHours() === 0 && now.getMinutes() === 0) {
        resetWeeklyStats();
    }
}, 60000); // Verificar a cada minuto

// Criar eventos especiais automáticos
function createAutoEvents() {
    const now = new Date();
    
    // Evento de fim de semana
    if (now.getDay() === 5) { // Sexta-feira
        const weekendStart = new Date(now);
        weekendStart.setHours(18, 0, 0, 0);
        
        const weekendEnd = new Date(now);
        weekendEnd.setDate(weekendEnd.getDate() + 2);
        weekendEnd.setHours(23, 59, 59, 999);
        
        createSpecialEvent({
            name: 'Fim de Semana Musical',
            description: 'Pontos dobrados no fim de semana!',
            type: 'double_points',
            startDate: weekendStart.toISOString(),
            endDate: weekendEnd.toISOString(),
            rewards: { pointsMultiplier: 2 }
        });
    }
    
    // Evento mensal de descoberta musical
    if (now.getDate() === 1) { // Primeiro dia do mês
        const monthStart = new Date(now);
        const monthEnd = new Date(now);
        monthEnd.setMonth(monthEnd.getMonth() + 1);
        monthEnd.setDate(0);
        monthEnd.setHours(23, 59, 59, 999);
        
        createSpecialEvent({
            name: 'Explorador Musical',
            description: 'Ouça músicas de diferentes gêneros para ganhar badges especiais!',
            type: 'genre_exploration',
            startDate: monthStart.toISOString(),
            endDate: monthEnd.toISOString(),
            rewards: { specialBadge: 'monthly_explorer', points: 200 }
        });
    }
}

// Verificar eventos automáticos diariamente
setInterval(createAutoEvents, 24 * 60 * 60 * 1000);

// Rotas da API
app.get('/api/playlist', (req, res) => {
    res.json(playlist);
});

app.get('/api/current', (req, res) => {
    res.json({
        currentSong: playlist[currentSongIndex] || null,
        isPlaying,
        currentIndex: currentSongIndex,
        shuffle: isShuffleEnabled,
        repeat: isRepeatEnabled,
        playMode
    });
});

app.post('/api/play', (req, res) => {
    const { songId } = req.body;
    if (songId) {
        const songIndex = playlist.findIndex(song => song.id === songId);
        if (songIndex !== -1) {
            currentSongIndex = songIndex;
        }
    }
    isPlaying = true;
    
    // Atualizar analytics quando música toca
    updateListenerStats(null, 'songPlay');
    
    io.emit('playStatusChanged', { 
        isPlaying, 
        currentSong: playlist[currentSongIndex],
        currentIndex: currentSongIndex 
    });
    res.json({ success: true });
});

app.post('/api/pause', (req, res) => {
    isPlaying = false;
    io.emit('playStatusChanged', { 
        isPlaying, 
        currentSong: playlist[currentSongIndex],
        currentIndex: currentSongIndex 
    });
    res.json({ success: true });
});

app.post('/api/next', (req, res) => {
    if (playlist.length > 0) {
        if (isShuffleEnabled) {
            currentSongIndex = Math.floor(Math.random() * playlist.length);
        } else if (isRepeatEnabled && playMode === 'repeat-one') {
            // Mantém a mesma música
        } else {
            currentSongIndex = (currentSongIndex + 1) % playlist.length;
        }
        
        // Atualizar analytics quando música muda
        if (isPlaying) {
            updateListenerStats(null, 'songPlay');
        }
        
        io.emit('songChanged', { 
            currentSong: playlist[currentSongIndex],
            currentIndex: currentSongIndex,
            isPlaying 
        });
    }
    res.json({ success: true });
});

app.post('/api/previous', (req, res) => {
    if (playlist.length > 0) {
        if (isShuffleEnabled) {
            currentSongIndex = Math.floor(Math.random() * playlist.length);
        } else {
            currentSongIndex = currentSongIndex > 0 ? currentSongIndex - 1 : playlist.length - 1;
        }
        
        // Atualizar analytics quando música muda
        if (isPlaying) {
            updateListenerStats(null, 'songPlay');
        }
        
        io.emit('songChanged', { 
            currentSong: playlist[currentSongIndex],
            currentIndex: currentSongIndex,
            isPlaying 
        });
    }
    res.json({ success: true });
});

app.post('/api/shuffle', (req, res) => {
    isShuffleEnabled = !isShuffleEnabled;
    playMode = isShuffleEnabled ? 'shuffle' : 'normal';
    io.emit('playModeChanged', { shuffle: isShuffleEnabled, repeat: isRepeatEnabled, playMode });
    res.json({ success: true, shuffle: isShuffleEnabled });
});

app.post('/api/repeat', (req, res) => {
    if (!isRepeatEnabled) {
        isRepeatEnabled = true;
        playMode = 'repeat-all';
    } else if (playMode === 'repeat-all') {
        playMode = 'repeat-one';
    } else {
        isRepeatEnabled = false;
        playMode = 'normal';
    }
    
    io.emit('playModeChanged', { shuffle: isShuffleEnabled, repeat: isRepeatEnabled, playMode });
    res.json({ success: true, repeat: isRepeatEnabled, playMode });
});

// Upload de música
app.post('/api/upload', upload.single('music'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const newSong = {
        id: playlist.length + 1,
        name: req.file.originalname.replace(/\.[^/.]+$/, ""),
        filename: req.file.filename,
        path: `/uploads/${req.file.filename}`
    };

    playlist.push(newSong);
    
    io.emit('playlistUpdated', playlist);
    res.json({ success: true, song: newSong });
});

// Deletar música
app.delete('/api/song/:id', (req, res) => {
    const songId = parseInt(req.params.id);
    const songIndex = playlist.findIndex(song => song.id === songId);
    
    if (songIndex !== -1) {
        const song = playlist[songIndex];
        
        // Remover arquivo se estiver na pasta uploads
        if (song.path.includes('/uploads/')) {
            const filePath = path.join(__dirname, 'public', 'uploads', song.filename);
            fs.removeSync(filePath);
        }
        
        playlist.splice(songIndex, 1);
        
        // Ajustar índice atual se necessário
        if (currentSongIndex >= songIndex) {
            currentSongIndex = Math.max(0, currentSongIndex - 1);
        }
        
        io.emit('playlistUpdated', playlist);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Música não encontrada' });
    }
});

// Chat endpoints
app.get('/api/chat', (req, res) => {
    res.json({ messages: chatMessages });
});

app.delete('/api/message/:id', (req, res) => {
    const messageId = req.params.id;
    chatMessages = chatMessages.filter(msg => msg.id !== messageId);
    io.emit('messageDeleted', messageId);
    res.json({ success: true });
});

// Music requests endpoints
app.get('/api/requests', (req, res) => {
    res.json({ requests: musicRequests });
});

app.delete('/api/request/:id', (req, res) => {
    const requestId = req.params.id;
    musicRequests = musicRequests.filter(req => req.id !== requestId);
    io.emit('requestDeleted', requestId);
    res.json({ success: true });
});

// Ban user
app.post('/api/ban-user', (req, res) => {
    const { username } = req.body;
    if (username && !bannedUsers.includes(username)) {
        bannedUsers.push(username);
        
        // Remove all messages from banned user
        chatMessages = chatMessages.filter(msg => msg.username !== username);
        io.emit('userBanned', username);
        io.emit('chatUpdated', chatMessages);
        
        res.json({ success: true });
    } else {
        res.json({ success: false, error: 'Username inválido ou já banido' });
    }
});

// Live streaming routes
app.post('/api/live/start', (req, res) => {
    if (!isLiveStreaming) {
        isLiveStreaming = true;
        isPlaying = false; // Pausar música quando live começar
        
        const liveMessage = {
            id: Date.now().toString(),
            username: 'Sistema',
            message: '🔴 TRANSMISSÃO AO VIVO INICIADA!',
            timestamp: new Date().toLocaleTimeString(),
            type: 'system'
        };
        
        chatMessages.push(liveMessage);
        io.emit('newMessage', liveMessage);
        io.emit('liveStreamingChanged', { isLive: true });
        
        res.json({ success: true });
    } else {
        res.json({ success: false, error: 'Já em transmissão ao vivo' });
    }
});

app.post('/api/live/stop', (req, res) => {
    if (isLiveStreaming) {
        isLiveStreaming = false;
        
        const liveMessage = {
            id: Date.now().toString(),
            username: 'Sistema',
            message: '⚫ Transmissão ao vivo encerrada',
            timestamp: new Date().toLocaleTimeString(),
            type: 'system'
        };
        
        chatMessages.push(liveMessage);
        io.emit('newMessage', liveMessage);
        io.emit('liveStreamingChanged', { isLive: false });
        
        res.json({ success: true });
    } else {
        res.json({ success: false, error: 'Não está em transmissão ao vivo' });
    }
});

// Programs routes
app.get('/api/programs', (req, res) => {
    res.json({ programs: scheduledPrograms });
});

app.post('/api/programs', (req, res) => {
    const { title, description, startTime, duration, isRecurring, daysOfWeek } = req.body;
    
    const program = {
        id: Date.now().toString(),
        title,
        description,
        startTime, // Format: "HH:MM"
        duration, // in minutes
        isRecurring: isRecurring || false,
        daysOfWeek: daysOfWeek || [], // [0,1,2,3,4,5,6] for Sunday-Saturday
        isActive: true,
        createdAt: new Date().toISOString()
    };
    
    scheduledPrograms.push(program);
    schedulePrograms();
    
    res.json({ success: true, program });
});

app.delete('/api/programs/:id', (req, res) => {
    const programId = req.params.id;
    scheduledPrograms = scheduledPrograms.filter(p => p.id !== programId);
    schedulePrograms();
    res.json({ success: true });
});

// Jingles routes
app.get('/api/jingles', (req, res) => {
    res.json({ jingles });
});

app.post('/api/jingles', upload.single('jingle'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo de jingle enviado' });
    }

    const { name, type, intervalMinutes } = req.body;
    
    const jingle = {
        id: Date.now().toString(),
        name: name || req.file.originalname.replace(/\.[^/.]+$/, ""),
        filename: req.file.filename,
        path: `/uploads/${req.file.filename}`,
        type: type || 'station', // station, commercial, transition
        intervalMinutes: parseInt(intervalMinutes) || 30,
        lastPlayed: null,
        isActive: true
    };

    jingles.push(jingle);
    setupAutoJingles();
    
    res.json({ success: true, jingle });
});

app.delete('/api/jingles/:id', (req, res) => {
    const jingleId = req.params.id;
    const jingleIndex = jingles.findIndex(j => j.id === jingleId);
    
    if (jingleIndex !== -1) {
        const jingle = jingles[jingleIndex];
        
        // Remover arquivo
        const filePath = path.join(__dirname, 'public', 'uploads', jingle.filename);
        fs.removeSync(filePath);
        
        jingles.splice(jingleIndex, 1);
        setupAutoJingles();
        
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Jingle não encontrado' });
    }
});

app.post('/api/jingles/:id/play', (req, res) => {
    const jingleId = req.params.id;
    const jingle = jingles.find(j => j.id === jingleId);
    
    if (jingle) {
        jingle.lastPlayed = new Date();
        io.emit('playJingle', jingle);
        
        const jingleMessage = {
            id: Date.now().toString(),
            username: 'Sistema',
            message: `🎵 Jingle: ${jingle.name}`,
            timestamp: new Date().toLocaleTimeString(),
            type: 'system'
        };
        
        chatMessages.push(jingleMessage);
        io.emit('newMessage', jingleMessage);
        
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Jingle não encontrado' });
    }
});

// Notifications routes
app.get('/api/notifications', (req, res) => {
    res.json({ notifications });
});

app.post('/api/notifications', (req, res) => {
    const { title, message, type, scheduledTime, isImmediate } = req.body;
    
    const notification = {
        id: Date.now().toString(),
        title,
        message,
        type: type || 'info', // info, warning, announcement, program
        scheduledTime: scheduledTime || null,
        isImmediate: isImmediate || false,
        sent: false,
        createdAt: new Date().toISOString()
    };
    
    notifications.push(notification);
    
    if (notification.isImmediate) {
        sendNotification(notification);
    } else if (notification.scheduledTime) {
        scheduleNotification(notification);
    }
    
    res.json({ success: true, notification });
});

app.delete('/api/notifications/:id', (req, res) => {
    const notificationId = req.params.id;
    notifications = notifications.filter(n => n.id !== notificationId);
    res.json({ success: true });
});

// Broadcast status
app.get('/api/broadcast/status', (req, res) => {
    res.json({
        isLive: isLiveStreaming,
        currentProgram,
        nextProgram: getNextProgram(),
        activeJingles: jingles.filter(j => j.isActive).length,
        scheduledPrograms: scheduledPrograms.filter(p => p.isActive).length
    });
});

// Analytics endpoints
app.get('/api/analytics', (req, res) => {
    res.json(getAnalyticsData());
});

// User Profile endpoints
app.post('/api/users/register', (req, res) => {
    const { username, email, avatar, bio, favoriteGenre } = req.body;
    
    // Verificar se username já existe
    const existingUser = Array.from(registeredUsers.values()).find(u => u.username === username);
    if (existingUser) {
        return res.status(400).json({ error: 'Nome de usuário já existe' });
    }
    
    const userId = Date.now().toString();
    const user = {
        id: userId,
        username,
        email,
        avatar: avatar || '/default-avatar.png',
        bio: bio || '',
        favoriteGenre: favoriteGenre || 'geral',
        joinDate: new Date().toISOString(),
        totalListeningTime: 0,
        favoriteSongs: [],
        friends: [],
        isOnline: false,
        lastSeen: new Date().toISOString()
    };
    
    registeredUsers.set(userId, user);
    userProfiles.set(userId, {
        preferences: { notifications: true, autoJoinGenreRoom: true },
        socialLinks: { twitter: '', instagram: '', spotify: '' }
    });
    
    res.json({ success: true, user: { ...user, password: undefined } });
});

app.post('/api/users/login', (req, res) => {
    const { username } = req.body;
    
    const user = Array.from(registeredUsers.values()).find(u => u.username === username);
    if (!user) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    user.isOnline = true;
    user.lastSeen = new Date().toISOString();
    
    res.json({ success: true, user: { ...user, password: undefined } });
});

app.get('/api/users/:userId', (req, res) => {
    const { userId } = req.params;
    const user = registeredUsers.get(userId);
    
    if (!user) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const profile = userProfiles.get(userId);
    res.json({ user: { ...user, password: undefined }, profile });
});

app.put('/api/users/:userId', (req, res) => {
    const { userId } = req.params;
    const updates = req.body;
    
    const user = registeredUsers.get(userId);
    if (!user) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    // Atualizar campos permitidos
    const allowedFields = ['bio', 'avatar', 'favoriteGenre'];
    allowedFields.forEach(field => {
        if (updates[field] !== undefined) {
            user[field] = updates[field];
        }
    });
    
    res.json({ success: true, user: { ...user, password: undefined } });
});

// Friends System endpoints
app.post('/api/friends/request', (req, res) => {
    const { fromUserId, toUserId } = req.body;
    
    if (!registeredUsers.has(fromUserId) || !registeredUsers.has(toUserId)) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const requestId = Date.now().toString();
    const request = {
        id: requestId,
        from: fromUserId,
        to: toUserId,
        status: 'pending',
        timestamp: new Date().toISOString()
    };
    
    if (!friendRequests.has(toUserId)) {
        friendRequests.set(toUserId, []);
    }
    
    friendRequests.get(toUserId).push(request);
    
    // Notificar usuário
    const fromUser = registeredUsers.get(fromUserId);
    io.emit('friendRequest', { request, fromUser: fromUser.username });
    
    res.json({ success: true, request });
});

app.post('/api/friends/accept', (req, res) => {
    const { userId, requestId } = req.body;
    
    const requests = friendRequests.get(userId) || [];
    const requestIndex = requests.findIndex(r => r.id === requestId);
    
    if (requestIndex === -1) {
        return res.status(404).json({ error: 'Solicitação não encontrada' });
    }
    
    const request = requests[requestIndex];
    request.status = 'accepted';
    
    // Adicionar como amigos
    if (!friendsList.has(userId)) {
        friendsList.set(userId, []);
    }
    if (!friendsList.has(request.from)) {
        friendsList.set(request.from, []);
    }
    
    friendsList.get(userId).push(request.from);
    friendsList.get(request.from).push(userId);
    
    // Atualizar arrays de amigos nos perfis
    const user = registeredUsers.get(userId);
    const friend = registeredUsers.get(request.from);
    
    user.friends.push(request.from);
    friend.friends.push(userId);
    
    res.json({ success: true });
});

app.get('/api/friends/:userId', (req, res) => {
    const { userId } = req.params;
    const friends = friendsList.get(userId) || [];
    
    const friendsData = friends.map(friendId => {
        const friend = registeredUsers.get(friendId);
        return {
            id: friend.id,
            username: friend.username,
            avatar: friend.avatar,
            isOnline: friend.isOnline,
            lastSeen: friend.lastSeen
        };
    });
    
    res.json({ friends: friendsData });
});

// Chat Rooms endpoints
app.get('/api/rooms', (req, res) => {
    const rooms = Array.from(chatRooms.values()).map(room => ({
        ...room,
        users: Array.from(room.users),
        userCount: room.users.size
    }));
    res.json({ rooms });
});

app.get('/api/rooms/:roomId/messages', (req, res) => {
    const { roomId } = req.params;
    const messages = roomMessages.get(roomId) || [];
    res.json({ messages: messages.slice(-50) }); // Últimas 50 mensagens
});

app.post('/api/rooms/:roomId/join', (req, res) => {
    const { roomId } = req.params;
    const { userId } = req.body;
    
    const room = chatRooms.get(roomId);
    if (!room) {
        return res.status(404).json({ error: 'Sala não encontrada' });
    }
    
    room.users.add(userId);
    
    const user = registeredUsers.get(userId);
    const joinMessage = {
        id: Date.now().toString(),
        username: 'Sistema',
        message: `${user.username} entrou na sala ${room.name}`,
        timestamp: new Date().toLocaleTimeString(),
        type: 'system',
        roomId
    };
    
    if (!roomMessages.has(roomId)) {
        roomMessages.set(roomId, []);
    }
    
    roomMessages.get(roomId).push(joinMessage);
    io.emit('roomMessage', joinMessage);
    
    res.json({ success: true });
});

// Song Comments endpoints
app.get('/api/songs/:songId/comments', (req, res) => {
    const { songId } = req.params;
    const comments = songComments.get(parseInt(songId)) || [];
    res.json({ comments });
});

app.post('/api/songs/:songId/comments', (req, res) => {
    const { songId } = req.params;
    const { userId, comment } = req.body;
    
    const user = registeredUsers.get(userId);
    if (!user) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    const commentObj = {
        id: Date.now().toString(),
        userId,
        username: user.username,
        avatar: user.avatar,
        comment,
        timestamp: new Date().toISOString(),
        likes: 0,
        likedBy: []
    };
    
    if (!songComments.has(parseInt(songId))) {
        songComments.set(parseInt(songId), []);
    }
    
    songComments.get(parseInt(songId)).push(commentObj);
    
    // Broadcast do novo comentário
    io.emit('newSongComment', { songId, comment: commentObj });
    
    res.json({ success: true, comment: commentObj });
});

app.post('/api/comments/:commentId/like', (req, res) => {
    const { commentId } = req.params;
    const { userId } = req.body;
    
    // Encontrar comentário
    let comment = null;
    let songId = null;
    
    for (const [id, comments] of songComments.entries()) {
        comment = comments.find(c => c.id === commentId);
        if (comment) {
            songId = id;
            break;
        }
    }
    
    if (!comment) {
        return res.status(404).json({ error: 'Comentário não encontrado' });
    }
    
    if (comment.likedBy.includes(userId)) {
        // Remover like
        comment.likedBy = comment.likedBy.filter(id => id !== userId);
        comment.likes--;
    } else {
        // Adicionar like
        comment.likedBy.push(userId);
        comment.likes++;
    }
    
    io.emit('commentLiked', { commentId, likes: comment.likes, songId });
    
    res.json({ success: true, likes: comment.likes });
});

// Social Sharing endpoints
app.post('/api/share/song', (req, res) => {
    const { songId, userId, platform } = req.body;
    
    const song = playlist.find(s => s.id === parseInt(songId));
    const user = registeredUsers.get(userId);
    
    if (!song || !user) {
        return res.status(404).json({ error: 'Música ou usuário não encontrado' });
    }
    
    const shareData = {
        id: Date.now().toString(),
        userId,
        username: user.username,
        songId,
        songName: song.name,
        platform,
        timestamp: new Date().toISOString(),
        url: `${req.protocol}://${req.get('host')}/?song=${songId}`
    };
    
    // Broadcast do compartilhamento
    const shareMessage = {
        id: Date.now().toString(),
        username: 'Sistema',
        message: `🎵 ${user.username} compartilhou "${song.name}" no ${platform}`,
        timestamp: new Date().toLocaleTimeString(),
        type: 'system'
    };
    
    chatMessages.push(shareMessage);
    io.emit('newMessage', shareMessage);
    
    res.json({ success: true, shareData });
});

app.get('/api/users/:userId/activity', (req, res) => {
    const { userId } = req.params;
    const user = registeredUsers.get(userId);
    
    if (!user) {
        return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    // Simular atividade recente
    const activity = [
        { type: 'listen', song: 'Exemplo 1', timestamp: new Date().toISOString() },
        { type: 'comment', song: 'Exemplo 2', timestamp: new Date().toISOString() },
        { type: 'friend', friend: 'Amigo Exemplo', timestamp: new Date().toISOString() }
    ];
    
    res.json({ activity });
});

app.get('/api/analytics/listeners', (req, res) => {
    res.json({
        simultaneousListeners: connectedListeners.size,
        connectedListeners: Array.from(connectedListeners.entries()).map(([socketId, listener]) => ({
            id: socketId,
            username: listener.username,
            connectedAt: new Date(listener.connectedAt).toLocaleString(),
            listeningTime: Math.round((Date.now() - listener.currentSessionStart) / 1000 / 60)
        }))
    });
});

app.get('/api/analytics/songs', (req, res) => {
    const topSongs = Array.from(songStats.values())
        .sort((a, b) => b.playCount - a.playCount)
        .map(song => ({
            id: song.id,
            name: song.name,
            playCount: song.playCount,
            totalListeningTime: Math.round(song.totalListeningTime / 1000 / 60),
            currentListeners: song.listeners.size
        }));
    
    res.json({ topSongs });
});

app.get('/api/analytics/reports', (req, res) => {
    const { period = 7 } = req.query;
    const days = parseInt(period);
    
    const reports = [];
    for (let i = days - 1; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        
        const dayStats = dailyStats.get(dateStr) || {
            uniqueListeners: new Set(),
            totalListeningTime: 0,
            songsPlayed: new Set()
        };
        
        reports.push({
            date: dateStr,
            uniqueListeners: dayStats.uniqueListeners.size,
            totalListeningTime: Math.round(dayStats.totalListeningTime / 1000 / 60),
            songsPlayed: dayStats.songsPlayed.size,
            avgListeningTime: dayStats.uniqueListeners.size > 0 ? 
                Math.round(dayStats.totalListeningTime / dayStats.uniqueListeners.size / 1000 / 60) : 0
        });
    }
    
    res.json({ reports });
});

// Gamification endpoints
app.get('/api/gamification/points/:userId', (req, res) => {
    const { userId } = req.params;
    initializeUserPoints(userId);
    
    const pointsData = userPoints.get(userId);
    const userBadgesList = userBadges.get(userId);
    const activities = userActivities.get(userId).slice(-20); // Últimas 20 atividades
    
    res.json({
        points: pointsData,
        badges: userBadgesList,
        recentActivities: activities
    });
});

app.get('/api/gamification/leaderboard', (req, res) => {
    const { period = 'alltime' } = req.query;
    
    updateLeaderboard();
    const leaderboardData = leaderboard.get(period) || [];
    
    res.json({
        period,
        leaderboard: leaderboardData,
        totalUsers: registeredUsers.size
    });
});

app.get('/api/gamification/badges', (req, res) => {
    res.json({
        availableBadges,
        pointsSystem
    });
});

app.get('/api/gamification/badges/:userId', (req, res) => {
    const { userId } = req.params;
    initializeUserPoints(userId);
    
    const userBadgesList = userBadges.get(userId);
    const earnedBadgeIds = userBadgesList.map(b => b.id);
    
    const badgesWithStatus = availableBadges.map(badge => {
        const earned = userBadgesList.find(b => b.id === badge.id);
        return {
            ...badge,
            earned: !!earned,
            earnedAt: earned ? earned.earnedAt : null,
            progress: calculateBadgeProgress(userId, badge.id)
        };
    });
    
    res.json({
        badges: badgesWithStatus,
        totalEarned: userBadgesList.length,
        totalAvailable: availableBadges.length
    });
});

function calculateBadgeProgress(userId, badgeId) {
    const userActivitiesList = userActivities.get(userId) || [];
    const userPointsData = userPoints.get(userId);
    
    if (!userPointsData) return 0;
    
    switch (badgeId) {
        case 'chat_rookie':
            const chatMessages = userActivitiesList.filter(a => a.type === 'chat_message').length;
            return Math.min(100, (chatMessages / 10) * 100);
            
        case 'chat_veteran':
            const totalChatMessages = userActivitiesList.filter(a => a.type === 'chat_message').length;
            return Math.min(100, (totalChatMessages / 100) * 100);
            
        case 'music_lover':
            const completeSongs = userActivitiesList.filter(a => a.type === 'song_listen_complete').length;
            return Math.min(100, (completeSongs / 50) * 100);
            
        case 'dedicated_listener':
            const listeningHours = userActivitiesList.filter(a => a.type === 'listening_time_hour').length;
            return Math.min(100, (listeningHours / 5) * 100);
            
        case 'social_butterfly':
            const friendsAdded = userActivitiesList.filter(a => a.type === 'add_friend').length;
            return Math.min(100, (friendsAdded / 5) * 100);
            
        case 'commenter':
            const comments = userActivitiesList.filter(a => a.type === 'song_comment').length;
            return Math.min(100, (comments / 25) * 100);
            
        case 'request_master':
            const requests = userActivitiesList.filter(a => a.type === 'music_request').length;
            return Math.min(100, (requests / 20) * 100);
            
        case 'like_giver':
            const likes = userActivitiesList.filter(a => a.type === 'comment_like').length;
            return Math.min(100, (likes / 100) * 100);
            
        case 'daily_visitor':
            return Math.min(100, (userPointsData.consecutiveDays / 7) * 100);
            
        case 'loyal_fan':
            return Math.min(100, (userPointsData.consecutiveDays / 30) * 100);
            
        default:
            return 0;
    }
}

app.get('/api/gamification/events', (req, res) => {
    const activeEvents = Array.from(specialEvents.values()).filter(event => {
        const now = new Date();
        const startDate = new Date(event.startDate);
        const endDate = new Date(event.endDate);
        return now >= startDate && now <= endDate;
    });
    
    res.json({
        activeEvents: activeEvents.map(event => ({
            ...event,
            participants: Array.from(event.participants),
            participantCount: event.participants.size
        }))
    });
});

app.post('/api/gamification/events/:eventId/join', (req, res) => {
    const { eventId } = req.params;
    const { userId } = req.body;
    
    const success = joinSpecialEvent(userId, eventId);
    
    if (success) {
        const event = specialEvents.get(eventId);
        res.json({ 
            success: true, 
            message: `Você entrou no evento "${event.name}"!`,
            event: {
                ...event,
                participants: Array.from(event.participants),
                participantCount: event.participants.size
            }
        });
    } else {
        res.status(400).json({ 
            success: false, 
            error: 'Não foi possível entrar no evento' 
        });
    }
});

app.post('/api/gamification/events', (req, res) => {
    const { name, description, type, duration = 24, rewards = {} } = req.body;
    
    const startDate = new Date();
    const endDate = new Date();
    endDate.setHours(endDate.getHours() + duration);
    
    const event = createSpecialEvent({
        name,
        description,
        type,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        rewards
    });
    
    res.json({ success: true, event });
});

app.get('/api/gamification/user-rank/:userId', (req, res) => {
    const { userId } = req.params;
    
    updateLeaderboard();
    
    const allTimeRank = leaderboard.get('alltime').find(entry => entry.userId === userId);
    const weeklyRank = leaderboard.get('weekly').find(entry => entry.userId === userId);
    const dailyRank = leaderboard.get('daily').find(entry => entry.userId === userId);
    
    res.json({
        allTime: allTimeRank || { position: null, points: 0 },
        weekly: weeklyRank || { position: null, points: 0 },
        daily: dailyRank || { position: null, points: 0 }
    });
});

// Socket.IO para tempo real
io.on('connection', (socket) => {
    console.log('Usuário conectado:', socket.id);
    
    // Variável para rastrear se o usuário está no chat
    let userInChat = false;
    let chatUsername = null;
    let currentUserId = null;
    let currentRoom = 'geral';
    
    // Registrar ouvinte para analytics
    updateListenerStats(socket.id, 'connect');

    // Enviar estado atual
    socket.emit('playlistUpdated', playlist);
    socket.emit('playStatusChanged', { 
        isPlaying, 
        currentSong: playlist[currentSongIndex],
        currentIndex: currentSongIndex 
    });
    socket.emit('playModeChanged', { shuffle: isShuffleEnabled, repeat: isRepeatEnabled, playMode });
    socket.emit('broadcastStatus', {
        isLive: isLiveStreaming,
        currentProgram,
        nextProgram: getNextProgram()
    });

    // Chat
    socket.on('sendMessage', (data) => {
        // Validação de nome de usuário
        const username = data.username ? data.username.trim() : '';
        if (!username || username.length < 2 || username.length > 20) {
            socket.emit('messageBanned', 'Nome de usuário deve ter entre 2 e 20 caracteres');
            return;
        }

        // Validar caracteres permitidos no nome (letras, números, espaços, alguns símbolos)
        const usernameRegex = /^[a-zA-Z0-9\s._-]+$/;
        if (!usernameRegex.test(username)) {
            socket.emit('messageBanned', 'Nome de usuário contém caracteres inválidos');
            return;
        }

        if (bannedUsers.includes(username)) {
            socket.emit('messageBanned', 'Você foi banido do chat');
            return;
        }

        // Limitação de tamanho da mensagem
        const messageText = data.message ? data.message.trim() : '';
        if (!messageText || messageText.length === 0) {
            socket.emit('messageBanned', 'Mensagem não pode estar vazia');
            return;
        }

        if (messageText.length > 200) {
            socket.emit('messageBanned', 'Mensagem muito longa (máximo 200 caracteres)');
            return;
        }

        // Mensagem de entrada (primeira vez que o usuário envia mensagem)
        if (!userInChat) {
            // Atualizar nome do usuário no analytics
            const listener = connectedListeners.get(socket.id);
            if (listener) {
                listener.username = username;
            }
            
            const joinMessage = {
                id: Date.now().toString() + '_join',
                username: 'Sistema',
                message: `${username} entrou no chat`,
                timestamp: new Date().toLocaleTimeString(),
                type: 'system'
            };
            chatMessages.push(joinMessage);
            io.emit('newMessage', joinMessage);
            
            userInChat = true;
            chatUsername = username;
        }

        const message = {
            id: Date.now().toString(),
            username: username,
            message: messageText,
            timestamp: new Date().toLocaleTimeString(),
            type: 'user'
        };

        chatMessages.push(message);
        
        // Manter apenas as últimas 100 mensagens
        if (chatMessages.length > 100) {
            chatMessages = chatMessages.slice(-100);
        }

        // Adicionar pontos por enviar mensagem
        if (currentUserId) {
            addUserPoints(currentUserId, 'chat_message', { message: messageText });
        }

        io.emit('newMessage', message);
    });

    // Music requests
    socket.on('requestMusic', (data) => {
        // Validação de nome de usuário
        const username = data.username ? data.username.trim() : '';
        if (!username || username.length < 2 || username.length > 20) {
            socket.emit('requestBanned', 'Nome de usuário deve ter entre 2 e 20 caracteres');
            return;
        }

        const usernameRegex = /^[a-zA-Z0-9\s._-]+$/;
        if (!usernameRegex.test(username)) {
            socket.emit('requestBanned', 'Nome de usuário contém caracteres inválidos');
            return;
        }

        if (bannedUsers.includes(username)) {
            socket.emit('requestBanned', 'Você foi banido e não pode fazer pedidos');
            return;
        }

        // Validação do nome da música
        const songName = data.songName ? data.songName.trim() : '';
        if (!songName || songName.length === 0) {
            socket.emit('requestBanned', 'Nome da música não pode estar vazio');
            return;
        }

        if (songName.length > 100) {
            socket.emit('requestBanned', 'Nome da música muito longo (máximo 100 caracteres)');
            return;
        }

        const artist = data.artist ? data.artist.trim() : '';
        if (artist.length > 100) {
            socket.emit('requestBanned', 'Nome do artista muito longo (máximo 100 caracteres)');
            return;
        }

        const request = {
            id: Date.now().toString(),
            username: username,
            songName: songName,
            artist: artist,
            timestamp: new Date().toLocaleTimeString()
        };

        musicRequests.push(request);
        
        // Manter apenas os últimos 50 pedidos
        if (musicRequests.length > 50) {
            musicRequests = musicRequests.slice(-50);
        }

        // Adicionar pontos por fazer pedido musical
        if (currentUserId) {
            addUserPoints(currentUserId, 'music_request', { songName, artist });
        }

        io.emit('newRequest', request);
    });

    // User authentication events
    socket.on('userLogin', (data) => {
        const { userId } = data;
        currentUserId = userId;
        userSessions.set(socket.id, userId);
        
        const user = registeredUsers.get(userId);
        if (user) {
            user.isOnline = true;
            user.lastSeen = new Date().toISOString();
            chatUsername = user.username;
            
            // Inicializar gamificação para o usuário
            initializeUserPoints(userId);
            checkDailyLogin(userId);
            
            // Verificar se é primeiro login para badge
            const userBadgesList = userBadges.get(userId);
            if (userBadgesList.length === 0) {
                const firstLoginBadge = availableBadges.find(b => b.id === 'first_login');
                if (firstLoginBadge) {
                    awardBadge(userId, firstLoginBadge);
                }
            }
            
            // Auto-join user's favorite genre room
            const profile = userProfiles.get(userId);
            if (profile && profile.preferences.autoJoinGenreRoom && user.favoriteGenre) {
                currentRoom = user.favoriteGenre;
                const room = chatRooms.get(currentRoom);
                if (room) {
                    room.users.add(userId);
                    socket.join(currentRoom);
                    addUserPoints(userId, 'room_visit', { roomId: currentRoom });
                }
            }
            
            socket.emit('userAuthenticated', { user: { ...user, password: undefined } });
            socket.emit('roomsList', Array.from(chatRooms.values()));
            
            // Enviar dados de gamificação
            const pointsData = userPoints.get(userId);
            const badges = userBadges.get(userId);
            socket.emit('gamificationData', {
                points: pointsData,
                badges,
                rank: {
                    daily: leaderboard.get('daily')?.find(entry => entry.userId === userId)?.position || null,
                    weekly: leaderboard.get('weekly')?.find(entry => entry.userId === userId)?.position || null,
                    alltime: leaderboard.get('alltime')?.find(entry => entry.userId === userId)?.position || null
                }
            });
        }
    });

    // Room events
    socket.on('joinRoom', (data) => {
        const { roomId, userId } = data;
        
        // Leave current room
        if (currentRoom) {
            socket.leave(currentRoom);
            const oldRoom = chatRooms.get(currentRoom);
            if (oldRoom && userId) {
                oldRoom.users.delete(userId);
            }
        }
        
        // Join new room
        currentRoom = roomId;
        socket.join(roomId);
        
        const room = chatRooms.get(roomId);
        if (room && userId) {
            room.users.add(userId);
            
            // Adicionar pontos por visitar sala
            addUserPoints(userId, 'room_visit', { roomId, roomName: room.name });
            
            const user = registeredUsers.get(userId);
            if (user) {
                const joinMessage = {
                    id: Date.now().toString(),
                    username: 'Sistema',
                    message: `${user.username} entrou na sala ${room.name}`,
                    timestamp: new Date().toLocaleTimeString(),
                    type: 'system',
                    roomId
                };
                
                if (!roomMessages.has(roomId)) {
                    roomMessages.set(roomId, []);
                }
                
                roomMessages.get(roomId).push(joinMessage);
                io.to(roomId).emit('roomMessage', joinMessage);
            }
        }
        
        // Send room messages
        const messages = roomMessages.get(roomId) || [];
        socket.emit('roomMessages', messages.slice(-50));
    });

    socket.on('sendRoomMessage', (data) => {
        const { roomId, userId, message } = data;
        
        const user = registeredUsers.get(userId);
        if (!user || bannedUsers.includes(user.username)) {
            socket.emit('messageBanned', 'Você foi banido do chat');
            return;
        }
        
        if (!message || message.trim().length === 0 || message.length > 200) {
            socket.emit('messageBanned', 'Mensagem inválida');
            return;
        }
        
        const messageObj = {
            id: Date.now().toString(),
            username: user.username,
            userId: user.id,
            avatar: user.avatar,
            message: message.trim(),
            timestamp: new Date().toLocaleTimeString(),
            type: 'user',
            roomId
        };
        
        if (!roomMessages.has(roomId)) {
            roomMessages.set(roomId, []);
        }
        
        roomMessages.get(roomId).push(messageObj);
        
        // Manter apenas as últimas 100 mensagens por sala
        if (roomMessages.get(roomId).length > 100) {
            roomMessages.set(roomId, roomMessages.get(roomId).slice(-100));
        }
        
        io.to(roomId).emit('roomMessage', messageObj);
    });

    // Friend events
    socket.on('sendFriendRequest', (data) => {
        const { fromUserId, toUsername } = data;
        
        const toUser = Array.from(registeredUsers.values()).find(u => u.username === toUsername);
        if (!toUser) {
            socket.emit('friendRequestError', 'Usuário não encontrado');
            return;
        }
        
        const request = {
            id: Date.now().toString(),
            from: fromUserId,
            to: toUser.id,
            status: 'pending',
            timestamp: new Date().toISOString()
        };
        
        if (!friendRequests.has(toUser.id)) {
            friendRequests.set(toUser.id, []);
        }
        
        friendRequests.get(toUser.id).push(request);
        
        const fromUser = registeredUsers.get(fromUserId);
        io.emit('friendRequestReceived', { 
            request, 
            fromUser: { 
                id: fromUser.id, 
                username: fromUser.username, 
                avatar: fromUser.avatar 
            },
            toUserId: toUser.id
        });
        
        socket.emit('friendRequestSent', 'Solicitação de amizade enviada!');
    });

    // Song comment events
    socket.on('addSongComment', (data) => {
        const { songId, userId, comment } = data;
        
        const user = registeredUsers.get(userId);
        if (!user) {
            socket.emit('commentError', 'Usuário não encontrado');
            return;
        }
        
        if (!comment || comment.trim().length === 0 || comment.length > 300) {
            socket.emit('commentError', 'Comentário inválido');
            return;
        }
        
        const commentObj = {
            id: Date.now().toString(),
            userId,
            username: user.username,
            avatar: user.avatar,
            comment: comment.trim(),
            timestamp: new Date().toISOString(),
            likes: 0,
            likedBy: []
        };
        
        if (!songComments.has(parseInt(songId))) {
            songComments.set(parseInt(songId), []);
        }
        
        songComments.get(parseInt(songId)).push(commentObj);
        
        // Adicionar pontos por comentar
        addUserPoints(userId, 'song_comment', { songId, comment: comment.trim() });
        
        io.emit('newSongComment', { songId, comment: commentObj });
    });

    socket.on('likeSongComment', (data) => {
        const { commentId, userId } = data;
        
        let comment = null;
        let songId = null;
        
        for (const [id, comments] of songComments.entries()) {
            comment = comments.find(c => c.id === commentId);
            if (comment) {
                songId = id;
                break;
            }
        }
        
        if (!comment) {
            socket.emit('commentError', 'Comentário não encontrado');
            return;
        }
        
        if (comment.likedBy.includes(userId)) {
            comment.likedBy = comment.likedBy.filter(id => id !== userId);
            comment.likes--;
        } else {
            comment.likedBy.push(userId);
            comment.likes++;
            
            // Adicionar pontos por curtir comentário
            addUserPoints(userId, 'comment_like', { commentId, songId });
        }
        
        io.emit('commentLiked', { commentId, likes: comment.likes, songId });
    });

    socket.on('disconnect', () => {
        console.log('Usuário desconectado:', socket.id);
        
        // Atualizar analytics
        updateListenerStats(socket.id, 'disconnect');
        
        // Atualizar status do usuário
        if (currentUserId) {
            const user = registeredUsers.get(currentUserId);
            if (user) {
                user.isOnline = false;
                user.lastSeen = new Date().toISOString();
            }
            
            // Remover da sala atual
            if (currentRoom) {
                const room = chatRooms.get(currentRoom);
                if (room) {
                    room.users.delete(currentUserId);
                    
                    const leaveMessage = {
                        id: Date.now().toString(),
                        username: 'Sistema',
                        message: `${user.username} saiu da sala`,
                        timestamp: new Date().toLocaleTimeString(),
                        type: 'system',
                        roomId: currentRoom
                    };
                    
                    if (!roomMessages.has(currentRoom)) {
                        roomMessages.set(currentRoom, []);
                    }
                    
                    roomMessages.get(currentRoom).push(leaveMessage);
                    io.to(currentRoom).emit('roomMessage', leaveMessage);
                }
            }
            
            userSessions.delete(socket.id);
        }
        
        // Mensagem de saída se o usuário estava no chat
        if (userInChat && chatUsername) {
            const leaveMessage = {
                id: Date.now().toString() + '_leave',
                username: 'Sistema',
                message: `${chatUsername} saiu do chat`,
                timestamp: new Date().toLocaleTimeString(),
                type: 'system'
            };
            chatMessages.push(leaveMessage);
            
            // Manter apenas as últimas 100 mensagens
            if (chatMessages.length > 100) {
                chatMessages = chatMessages.slice(-100);
            }
            
            io.emit('newMessage', leaveMessage);
        }
    });
});

// Iniciar servidor
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎵 WebRadio servidor rodando na porta ${PORT}`);
    console.log(`📻 Acesse: http://localhost:${PORT}`);
    console.log(`⚙️  Admin: http://localhost:${PORT}/admin.html`);
    console.log(`🎶 Playlist carregada: ${playlist.length} músicas`);
});
