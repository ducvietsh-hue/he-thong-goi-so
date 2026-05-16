const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, getDoc, collection, addDoc } = require('firebase/firestore');

// -----------------------------------------
// CẤU HÌNH FIREBASE
// -----------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyCSGXe3sGOjhroFUmYaMSiiLQ0OYmVXCs0",
  authDomain: "laysothutuchanhchinh.firebaseapp.com",
  projectId: "laysothutuchanhchinh",
  storageBucket: "laysothutuchanhchinh.firebasestorage.app",
  messagingSenderId: "78960955255",
  appId: "1:78960955255:web:16f8bd1dfcbc1c71dd1b72",
  measurementId: "G-89P40QKP46"
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));

// Đảm bảo mọi truy cập đều trỏ về file index.html (Khắc phục lỗi Cannot GET /)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -----------------------------------------
// CẤU HÌNH TÀI KHOẢN QUẢN TRỊ 
// -----------------------------------------
const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'Abc@123';

// -----------------------------------------
// DỮ LIỆU STATE (Khớp với dữ liệu của Tailwind UI)
// -----------------------------------------
let state = {
    waitingList: [],
    historyList: [],
    stats: {},
    currentServing: null,
    nextNumberToIssue: 1001,
    marqueeText: 'Kính chào công dân! Vui lòng chuẩn bị sẵn Căn cước công dân và các giấy tờ cần thiết trong lúc chờ đợi để được phục vụ nhanh chóng. Xin cảm ơn!',
    counters: [
        { id: '1', name: 'Quầy 01', rank: '', staff: '' },
        { id: '2', name: 'Quầy 02', rank: '', staff: '' }
    ]
};

const DATA_FILE = path.join(__dirname, 'data.json');

async function loadState() {
    try {
        // Ưu tiên đọc dữ liệu từ Firebase
        const docSnap = await getDoc(doc(db, "queueSystem", "currentState"));
        if (docSnap.exists()) {
            const cloudState = docSnap.data();
            state = { ...state, ...cloudState }; // Gộp dữ liệu để không mất các biến mặc định
            state.stats = state.stats || {};
            console.log('☁️ [Firebase] Đã tải dữ liệu thành công từ đám mây.');
            return;
        }
    } catch (err) {
        console.error('⚠️ [Lỗi Firebase] Không thể tải dữ liệu đám mây:', err.message);
    }
    
    try {
        // Nếu Firebase chưa có hoặc bị lỗi (mất mạng), đọc dự phòng từ file data.json
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf8');
            const localState = JSON.parse(data);
            state = { ...state, ...localState }; // Gộp dữ liệu để không mất các biến mặc định
            state.stats = state.stats || {};
            console.log('📁 [Local] Đã tải dữ liệu dự phòng từ máy chủ nội bộ.');
        }
    } catch (err) {
        console.error('⚠️ [Lỗi Local] Không thể đọc dữ liệu nội bộ:', err.message);
    }
}

function saveState() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(state), 'utf8');
    } catch (err) {
        console.error('⚠️ [Lỗi Local] Không thể lưu dữ liệu:', err.message);
    }
    
    try {
        // Đồng bộ dữ liệu hiện tại lên Firebase Firestore
        setDoc(doc(db, "queueSystem", "currentState"), state).catch(e => console.error('⚠️ [Lỗi Firebase]', e.message));
    } catch (err) {
        console.error('⚠️ [Lỗi Firebase] Firebase chưa được khởi tạo đúng cách:', err.message);
    }
}

io.on('connection', (socket) => {
    console.log(`[+] Thiết bị kết nối mới: ${socket.id}`);

    socket.emit('updateQueue', state);

    socket.on('login', (credentials) => {
        if (credentials.username === ADMIN_USER && credentials.password === ADMIN_PASSWORD) {
            socket.emit('loginSuccess');
        } else {
            socket.emit('loginFail');
        }
    });

    socket.on('registerTicket', (userData) => {
        const newTicket = {
            number: state.nextNumberToIssue++,
            name: userData.name,
            dob: userData.dob,
            address: userData.address,
            service: userData.service,
            serviceCode: userData.serviceCode,
            timestamp: new Date().toISOString()
        };
        
        state.waitingList.push(newTicket);
        saveState(); 
        
        console.log(`[Ticket] Khách hàng ${userData.name} lấy số: ${newTicket.number}`);
        socket.emit('ticketIssued', newTicket);
        io.emit('updateQueue', state);
    });

    socket.on('callNext', (data) => {
        if (state.waitingList.length === 0) return; 

        const nextPerson = state.waitingList.shift();
        
        if (state.currentServing) {
            state.historyList.unshift(state.currentServing);
            if (state.historyList.length > 20) state.historyList.pop();
            
            // Thống kê số lượng thủ tục đã giải quyết
            if (!state.stats) state.stats = {};
            const serviceType = state.currentServing.service;
            state.stats[serviceType] = (state.stats[serviceType] || 0) + 1;

            // LƯU VĨNH VIỄN LỊCH SỬ GIAO DỊCH LÊN FIREBASE ĐỂ LÀM BÁO CÁO
            try {
                addDoc(collection(db, "historyLogs"), {
                    ...state.currentServing,
                    completedAt: new Date().toISOString()
                }).catch(e => console.error('⚠️ [Lỗi Firebase]', e.message));
            } catch (err) {}
        }

        state.currentServing = {
            ...nextPerson,
            counter: data.counterId,
            callTime: new Date().toISOString()
        };

        saveState();
        console.log(`[Call] Gọi số: ${state.currentServing.number} tại Quầy ${data.counterId}`);
        io.emit('updateQueue', state);
    });

    socket.on('updateMarquee', (data) => {
        if (data && data.text) {
            state.marqueeText = data.text;
            saveState();
            console.log(`[Marquee] Đã thay đổi thông báo thành: ${state.marqueeText}`);
            io.emit('updateQueue', state);
        }
    });

    socket.on('updateCounters', (newCounters) => {
        if (Array.isArray(newCounters)) {
            state.counters = newCounters;
            saveState();
            console.log(`[Config] Đã cập nhật danh sách quầy và cán bộ.`);
            io.emit('updateQueue', state);
        }
    });

    socket.on('resetSystem', () => {
        state = { waitingList: [], historyList: [], stats: {}, currentServing: null, nextNumberToIssue: 1001, marqueeText: state.marqueeText, counters: state.counters };
        saveState();
        console.log(`[Reset] Hệ thống đã được làm mới về 0 bởi thiết bị: ${socket.id}`);
        io.emit('updateQueue', state);
    });

    socket.on('disconnect', () => {
        console.log(`[-] Thiết bị ngắt kết nối: ${socket.id}`);
    });
});

function scheduleMidnightReset() {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    const timeToMidnight = nextMidnight.getTime() - now.getTime();

    setTimeout(() => {
        state = { waitingList: [], historyList: [], stats: {}, currentServing: null, nextNumberToIssue: 1001, marqueeText: state.marqueeText, counters: state.counters };
        saveState();
        console.log('[Auto-Reset] Hệ thống đã tự động làm mới về 0 vào lúc nửa đêm.');
        io.emit('updateQueue', state);
        scheduleMidnightReset();
    }, timeToMidnight);
}

const PORT = process.env.PORT || 3000;

loadState().then(() => {
    scheduleMidnightReset();
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server đang chạy thành công tại cổng ${PORT}`);
        console.log(`👉 Truy cập trên máy tính: http://localhost:${PORT}`);
    });
});