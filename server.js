const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, getDoc, collection, addDoc, getDocs, deleteDoc } = require('firebase/firestore');

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

// Endpoint siêu nhẹ để các dịch vụ bên ngoài ping giữ server luôn thức (chống ngủ đông)
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

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
    skippedList: [],
    stats: {},
    currentServing: null,
    nextNumberToIssue: 1,
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
            state.skippedList = state.skippedList || [];
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
            state.skippedList = state.skippedList || [];
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
        // Kiểm tra chống spam: Giới hạn mỗi số điện thoại hoặc Mã hồ sơ DVC chỉ được lấy 1 số trong ngày
        if (userData.serviceCode || userData.phone) {
            const isDuplicate = state.waitingList.some(ticket => 
                (userData.serviceCode && ticket.serviceCode === userData.serviceCode) ||
                (userData.phone && ticket.phone === userData.phone)
            ) || state.historyList.some(ticket => 
                (userData.serviceCode && ticket.serviceCode === userData.serviceCode) ||
                (userData.phone && ticket.phone === userData.phone)
            );
            
            if (isDuplicate) {
                socket.emit('registrationError', 'Lỗi: Số điện thoại hoặc Mã hồ sơ này đã được sử dụng để lấy số trong ngày hôm nay! Mỗi người chỉ được lấy 1 số/ngày.');
                return;
            }
        }

        const newTicket = {
            number: state.nextNumberToIssue++,
            name: userData.name,
            dob: userData.dob,
            address: userData.address,
            phone: userData.phone,
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

    // Xử lý sự kiện Cán bộ báo vắng mặt (Bỏ qua số hiện tại)
    socket.on('skipCurrent', () => {
        if (state.currentServing) {
            state.skippedList.push(state.currentServing);
            console.log(`[Skip] Đã chuyển số ${state.currentServing.number} vào danh sách vắng mặt.`);
            state.currentServing = null;
            saveState();
            io.emit('updateQueue', state);
        }
    });

    // Xử lý sự kiện Cán bộ gọi lại người đã vắng mặt
    socket.on('recallCitizen', (data) => {
        const citizenIndex = state.skippedList.findIndex(c => c.number === data.number);
        if (citizenIndex !== -1) {
            const recalledCitizen = state.skippedList.splice(citizenIndex, 1)[0];
            
            // Đẩy người đang phục vụ hiện tại (nếu có) vào lịch sử
            if (state.currentServing) {
                state.historyList.unshift(state.currentServing);
                if (state.historyList.length > 20) state.historyList.pop();
                
                if (!state.stats) state.stats = {};
                const serviceType = state.currentServing.service;
                state.stats[serviceType] = (state.stats[serviceType] || 0) + 1;
            }

            state.currentServing = {
                ...recalledCitizen,
                counter: data.counterId,
                callTime: new Date().toISOString()
            };

            saveState();
            console.log(`[Recall] Gọi lại số: ${state.currentServing.number} tại Quầy ${data.counterId}`);
            io.emit('updateQueue', state);
        }
    });

    // Xử lý sự kiện Xóa người vắng mặt khỏi danh sách
    socket.on('deleteSkippedTicket', (number) => {
        const citizenIndex = state.skippedList.findIndex(c => c.number === number);
        if (citizenIndex !== -1) {
            state.skippedList.splice(citizenIndex, 1);
            saveState();
            console.log(`[Delete] Đã xóa số ${number} khỏi danh sách vắng mặt.`);
            io.emit('updateQueue', state);
        }
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

    socket.on('resetSystem', async () => {
        state = { waitingList: [], historyList: [], skippedList: [], stats: {}, currentServing: null, nextNumberToIssue: 1, marqueeText: state.marqueeText, counters: state.counters };
        saveState();
        
        // Xóa toàn bộ lịch sử trên Firebase khi Cán bộ bấm reset thủ công
        try {
            const querySnapshot = await getDocs(collection(db, "historyLogs"));
            querySnapshot.forEach((document) => {
                deleteDoc(doc(db, "historyLogs", document.id)).catch(()=>{});
            });
        } catch (err) {
            console.error('⚠️ [Lỗi Firebase] Xóa lịch sử thất bại:', err.message);
        }

        console.log(`[Reset] Hệ thống đã được làm mới về 0 bởi thiết bị: ${socket.id}`);
        io.emit('updateQueue', state);
    });

    socket.on('disconnect', () => {
        console.log(`[-] Thiết bị ngắt kết nối: ${socket.id}`);
    });
});

// Lên lịch tự động reset dữ liệu vào 00:00 mỗi ngày theo giờ Việt Nam
cron.schedule('0 0 * * *', async () => {
    state = { waitingList: [], historyList: [], skippedList: [], stats: {}, currentServing: null, nextNumberToIssue: 1, marqueeText: state.marqueeText, counters: state.counters };
    saveState();
    
    // Tự động xóa toàn bộ lịch sử trên Firebase vào nửa đêm
    try {
        const querySnapshot = await getDocs(collection(db, "historyLogs"));
        querySnapshot.forEach((document) => {
            deleteDoc(doc(db, "historyLogs", document.id)).catch(()=>{});
        });
        console.log('☁️ [Firebase] Đã tự động dọn dẹp lịch sử (historyLogs) lúc 00:00.');
    } catch (err) {
        console.error('⚠️ [Lỗi Firebase] Dọn dẹp lịch sử thất bại:', err.message);
    }

    console.log('[Auto-Reset] Hệ thống đã tự động làm mới về 0 vào lúc 00:00 (Giờ VN).');
    if (io) {
        io.emit('updateQueue', state);
    }
}, {
    scheduled: true,
    timezone: "Asia/Ho_Chi_Minh"
});

const PORT = process.env.PORT || 3000;

loadState().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server đang chạy thành công tại cổng ${PORT}`);
        console.log(`👉 Truy cập trên máy tính: http://localhost:${PORT}`);
    });
});