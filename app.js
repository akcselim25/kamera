let peer = null;
let conn = null; // Veri kanalı
let call = null; // Medya kanalı
let isCamera = false;

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const alertBox = document.getElementById('alert');

// Durum Göstergeleri
const connStatus = document.getElementById('conn-status');
const aiStatus = document.getElementById('ai-status');
const pulse = document.getElementById('conn-pulse');

// AI Değişkenleri
let model = null;
let lastPersonTime = Date.now();
const ALERT_TIMEOUT = 1000;
let isAlerting = false;
let vibrateInterval;

let currentPeople = [];
let lockedTarget = null;
let isDetecting = false;

// 1. Rastgele 5 Haneli Kod Oluşturucu
function generateCode() {
    return Math.floor(10000 + Math.random() * 90000).toString();
}

/** Tıklama Olayları: Yeni Kişi Seçme ve Kilitleme Mantığı */
canvas.addEventListener('click', (e) => {
    if (!isCamera || !currentPeople || currentPeople.length === 0) return;
    
    // Canvasın ekrandaki boyutuna göre tıklama koordinatlarını bul
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    // Touch API destekliyse e.touches kontrolü de yapılabilinir, ama basit click yetiyor PWA'da
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const clickX = (clientX - rect.left) * scaleX;
    const clickY = (clientY - rect.top) * scaleY;

    for (let person of currentPeople) {
        const [x, y, w, h] = person.bbox;
        if (clickX >= x && clickX <= x + w && clickY >= y && clickY <= y + h) {
            lockOnPerson(person);
            break;
        }
    }
});

function lockOnPerson(person) {
    const [x, y, w, h] = person.bbox;
    lockedTarget = { x: x + w/2, y: y + h/2, bbox: person.bbox };
    document.getElementById('unlockBtn').style.display = 'block';
    
    aiStatus.innerText = "🎯 HEDEFE KİLİTLENİLDİ!";
    aiStatus.style.color = "#4CAF50";
    lastPersonTime = Date.now();
}

window.unlockTarget = function() {
    lockedTarget = null;
    document.getElementById('unlockBtn').style.display = 'none';
    aiStatus.innerText = "Sistem Hazır - Kişiye Dokunun";
    aiStatus.style.color = "#00bcd4";
    
    // İzleyiciye her şey yolunda sinyali gönder
    if(conn && conn.open) {
        conn.send({ type: 'person_in' });
    }
}

/** 2. YAPAY ZEKA MODELLERİ */
async function loadModel() {
    aiStatus.innerText = "Yapay Zeka Yükleniyor...";
    try { await tf.ready(); } catch(e) {}
    
    model = await cocoSsd.load();
    aiStatus.innerText = "Sistem Hazır - İzleyici Bekleniyor...";
    
    video.addEventListener('loadedmetadata', () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    });
    
    detectFrame();
}

async function detectFrame() {
    if (!isCamera || !model) return;
    
    if (video.readyState === 4 && !isDetecting) {
        isDetecting = true;
        
        if (canvas.width !== video.videoWidth && video.videoWidth > 0) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const predictions = await model.detect(video);
        
        // SADECE İNSANLARI FİLTRELE
        currentPeople = predictions.filter(p => p.class === 'person' && p.score > 0.40);

        let targetFound = false;

        if (lockedTarget) {
            let bestMatch = null;
            let minDistance = 250; 

            currentPeople.forEach(person => {
                const [x, y, w, h] = person.bbox;
                const centerX = x + w/2;
                const centerY = y + h/2;
                
                const dist = Math.hypot(centerX - lockedTarget.x, centerY - lockedTarget.y);
                if (dist < minDistance) {
                    minDistance = dist;
                    bestMatch = person;
                }
            });

            if (bestMatch) {
                targetFound = true;
                const [x, y, w, h] = bestMatch.bbox;
                lockedTarget = { x: x + w/2, y: y + h/2, bbox: bestMatch.bbox };
                
                // YEŞİL KİLİT ÇERÇEVESİ
                ctx.strokeStyle = '#00FF00'; 
                ctx.fillStyle = '#00FF00';
                ctx.lineWidth = 4;
                ctx.strokeRect(x, y, w, h);
                
                ctx.font = 'bold 22px Arial';
                ctx.fillText(`🎯 KİLİTLİ HEDEF`, x, y > 25 ? y - 10 : 25);
            }

            // Diğer umursanmayan kişiler
            currentPeople.forEach(person => {
                if (person !== bestMatch) {
                    const [px, py, pw, ph] = person.bbox;
                    ctx.strokeStyle = 'rgba(255, 0, 0, 0.4)'; 
                    ctx.lineWidth = 2;
                    ctx.strokeRect(px, py, pw, ph);
                }
            });

        } else {
            // MAVİ SEÇİLEBİLİR REK
            currentPeople.forEach(person => {
                const [x, y, w, h] = person.bbox;
                ctx.strokeStyle = '#00bcd4'; 
                ctx.fillStyle = '#00bcd4';
                ctx.lineWidth = 3;
                ctx.strokeRect(x, y, w, h);
                
                ctx.font = '18px Arial';
                ctx.fillText(`👆 Dokun`, x, y > 20 ? y - 10 : 20);
                
                ctx.beginPath();
                ctx.arc(x + w/2, y + h/2, 8, 0, 2 * Math.PI);
                ctx.fillStyle = 'rgba(0, 188, 212, 0.6)';
                ctx.fill();
            });
            
            targetFound = true; 
        }

        // ALARM MANTIĞI: Veriyi PeerJS DataChannel ile ilet
        if (lockedTarget) {
            if (targetFound) {
                lastPersonTime = Date.now();
                if (aiStatus.innerText.indexOf('✅') === -1) {
                    aiStatus.innerText = `✅ Hedef Görüş Alanında`;
                    aiStatus.style.color = "#4CAF50";
                    if(conn && conn.open) conn.send({ type: 'person_in' }); 
                }
            } else {
                const timeSinceLastPerson = Date.now() - lastPersonTime;
                if (timeSinceLastPerson >= ALERT_TIMEOUT) {
                    if (aiStatus.innerText !== `❌ HEDEF KAYIP!`) {
                        aiStatus.innerText = `❌ HEDEF KAYIP!`;
                        aiStatus.style.color = "#f44336";
                        if(conn && conn.open) conn.send({ type: 'person_out' }); 
                    }
                }
            }
        }
        
        isDetecting = false;
    }
    
    requestAnimationFrame(detectFrame);
}

/** 3. KAMERA YAYINCI SEÇENEĞİ */
async function startCameraMode() {
    isCamera = true;
    document.getElementById('role-selection').style.display = 'none';
    document.getElementById('main').style.display = 'flex';
    document.getElementById('cam-controls').style.display = 'block';
    
    // Kamerayı aç
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: 640 }, audio: false });
        video.srcObject = stream;
        video.muted = true;
    } catch (err) {
        alert("Kamera Açılamadı veya İzin Verilmedi!");
        location.reload();
        return;
    }

    // Telefonlar-arası ID'yi basitleştirmek için kısa kod kullanıyoruz, 
    // ama gerçek Peer id olarak prefix koyalım ki çakışma olmasın.
    const shortCode = generateCode();
    const peerId = `phtrck-${shortCode}`;
    document.getElementById('my-code').innerText = shortCode;

    connStatus.innerText = "Sunucuya Kayıt Olunuyor...";
    pulse.className = 'pulse';

    // PeerJS Başlat: STUN serverlar varsayılan PeerJS cloud'da ücretsiz.
    peer = new Peer(peerId, { debug: 2 });
    
    peer.on('open', (id) => {
        connStatus.innerText = "Yayınla... İzleyici Bekleniyor!";
        pulse.className = 'pulse green';
        document.getElementById('lock-controls').style.display = 'block';
        loadModel(); // Model yüklemeye başla
    });

    peer.on('connection', (connection) => {
        conn = connection;
        connStatus.innerText = "İzleyici Bağlandı! (Aktif)";
        
        conn.on('data', (data) => {
            if(data.type === 'viewer_ready') {
                // İzleyici hazır, ona medyayı gönder
                peer.call(conn.peer, stream);
            }
        });
        
        conn.on('close', () => {
            connStatus.innerText = "İzleyici Ayrıldı!";
        });
    });
}

/** 4. İZLEYİCİ BAĞLANTI */
function showViewerInput() {
    document.getElementById('role-selection').style.display = 'none';
    document.getElementById('viewer-setup').style.display = 'flex';
}

function connectToCamera() {
    const code = document.getElementById('join-code').value.trim();
    if(code.length !== 5) { alert("Lütfen 5 Haneli Kodu Eksiksiz Girin!"); return; }

    document.getElementById('viewer-setup').style.display = 'none';
    document.getElementById('main').style.display = 'flex';
    document.getElementById('cam-controls').style.display = 'none'; // kamera kontrolleri gizli
    isCamera = false;
    
    video.muted = true; // Telefondan telefona izleme ses sorun olabiliyor.

    connStatus.innerText = "Bağlanılıyor...";
    aiStatus.innerText = "Görüntü Bekleniyor";
    pulse.className = 'pulse';

    // Kendi rastgele peer ID'mizle bağlan
    peer = new Peer({ debug: 2 });

    peer.on('open', (id) => {
        const targetPeerId = `phtrck-${code}`;
        
        // Veri bağlantısı kur (Alarmlar için)
        conn = peer.connect(targetPeerId);
        
        conn.on('open', () => {
            connStatus.innerText = "Bağlandı!";
            pulse.className = 'pulse green';
            // Bağlandığımı bildir ki beni arasın
            conn.send({ type: 'viewer_ready' });
        });

        conn.on('data', handleAlertData);
        
        conn.on('close', () => {
            connStatus.innerText = "Bağlantı Koptu!";
            pulse.className = 'pulse';
            if(isAlerting) clearAlertDisplay();
        });
    });

    // Medya gelirse oynat
    peer.on('call', (incomingCall) => {
        call = incomingCall;
        call.answer(); // Gelen çağrıyı sadesiyle kabul et (biz bir şey göndermiyoruz)
        
        call.on('stream', (remoteStream) => {
            if (!video.srcObject) {
                video.srcObject = remoteStream;
                aiStatus.innerText = "✅ Canlı İzleniyor: " + code;
                aiStatus.style.color = "#4CAF50";
            }
        });
    });

    peer.on('error', (err) => {
        console.error(err);
        if (err.type === 'peer-unavailable') {
            alert("Kamera bulunamadı! Kodu kontrol edin ve Kameranın açık olduğundan emin olun.");
            location.reload();
        }
    });
}

function handleAlertData(data) {
    if (data.type === 'person_out') {
        if (!isAlerting) {
            isAlerting = true;
            alertBox.style.display = 'flex'; 
            aiStatus.innerText = "UYARI: KAMERADAKİ KİŞİ AYRILDI!";
            aiStatus.style.color = "#ff0000";
            
            if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);
            vibrateInterval = setInterval(() => {
                if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);
            }, 800); 
        }
    } else if (data.type === 'person_in') {
        clearAlertDisplay();
    }
}

function clearAlertDisplay() {
    if (isAlerting) {
        isAlerting = false;
        alertBox.style.display = 'none'; 
        aiStatus.innerText = "✅ Canlı ve İzleniyor";
        aiStatus.style.color = "#4CAF50";
        clearInterval(vibrateInterval);
    }
}
