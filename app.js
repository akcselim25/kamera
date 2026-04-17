// ===================================================================
// MOBİL AI İZLEME - MediaPipe WASM Sürümü (TensorFlow.js'den 5-10x hızlı)
// ===================================================================
// MediaPipe, Google'ın mobil cihazlar için özel geliştirdiği AI motoru.
// WASM + WebGL kullanır, TensorFlow.js'nin JS overhead'i yoktur.
// Telefonda gerçek zamanlı (~15-25 FPS) insan tespiti yapabilir.
// ===================================================================

let peer = null;
let conn = null;
let call = null;
let isCamera = false;

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const alertBox = document.getElementById('alert');

const connStatus = document.getElementById('conn-status');
const aiStatus = document.getElementById('ai-status');
const pulse = document.getElementById('conn-pulse');

// AI Değişkenleri
let detector = null; // MediaPipe ObjectDetector
let lastPersonTime = Date.now();
const ALERT_TIMEOUT = 1500;
let isAlerting = false;
let vibrateInterval;

let currentPeople = [];
let lockedTarget = null;
let isDetecting = false;
let lastDetectTime = 0;

// Filtreleme
const MIN_BBOX_RATIO = 0.012; // Ekranın %1.2'sinden küçük kutuları reddet

function isValidPersonShape(w, h) {
    const ratio = h / w;
    return ratio > 0.7 && ratio < 6.0;
}

function generateCode() {
    return Math.floor(10000 + Math.random() * 90000).toString();
}

// =================== TIKKLAMA OLAYLARI ===================
canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const clickX = (clientX - rect.left) * scaleX;
    const clickY = (clientY - rect.top) * scaleY;

    if (!isCamera) {
        if (conn && conn.open) {
            conn.send({ type: 'viewer_click', x: clickX, y: clickY, w: canvas.width, h: canvas.height });
        }
        return;
    }

    if (!currentPeople || currentPeople.length === 0) return;

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
    
    if (!isCamera) {
        if (conn && conn.open) conn.send({ type: 'viewer_unlock' });
        aiStatus.innerText = "Kilit Açıldı - Kişiye Dokunun";
        aiStatus.style.color = "#00bcd4";
        return;
    }

    aiStatus.innerText = "Sistem Hazır - Kişiye Dokunun";
    aiStatus.style.color = "#00bcd4";
    
    if(conn && conn.open) {
        conn.send({ type: 'person_in' });
    }
}

// IoU hesaplama
function getIoU(box1, box2) {
    const [x1, y1, w1, h1] = box1;
    const [x2, y2, w2, h2] = box2;
    const xA = Math.max(x1, x2);
    const yA = Math.max(y1, y2);
    const xB = Math.min(x1 + w1, x2 + w2);
    const yB = Math.min(y1 + h1, y2 + h2);
    const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
    if (interArea === 0) return 0;
    return interArea / ((w1 * h1) + (w2 * h2) - interArea);
}

// =================== MEDIAPIPE AI MOTORU ===================
async function loadModel() {
    const loadingContainer = document.getElementById('loading-container');
    const loadingFill = document.getElementById('loading-fill');
    const loadingText = document.getElementById('loading-text');
    
    if (loadingContainer) loadingContainer.style.display = 'block';
    
    aiStatus.innerText = "AI Motoru Yükleniyor...";
    if (loadingFill) loadingFill.style.width = '10%';
    if (loadingText) loadingText.innerText = 'MediaPipe WASM yükleniyor...';
    
    try {
        // MediaPipe Vision modülünü dinamik olarak yükle (sadece ihtiyaç duyulduğunda)
        if (loadingFill) loadingFill.style.width = '25%';
        const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
        
        if (loadingFill) loadingFill.style.width = '50%';
        if (loadingText) loadingText.innerText = 'GPU hazırlanıyor...';
        
        // WASM dosyalarını yükle (GPU hızlandırma)
        const filesetResolver = await vision.FilesetResolver.forVisionTasks(
            'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
        );
        
        if (loadingFill) loadingFill.style.width = '75%';
        if (loadingText) loadingText.innerText = 'AI modeli indiriliyor...';
        
        // EfficientDet-Lite0: Mobil için optimize, çok hızlı
        detector = await vision.ObjectDetector.createFromOptions(filesetResolver, {
            baseOptions: {
                modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
                delegate: 'GPU' // WebGL GPU hızlandırma
            },
            categoryAllowlist: ['person'], // SADECE insan algıla (diğer nesneleri yoksay)
            scoreThreshold: 0.40,
            maxResults: 10,
            runningMode: 'VIDEO' // Video modu: kareler arası optimizasyon yapar
        });
        
        if (loadingFill) loadingFill.style.width = '100%';
        if (loadingText) loadingText.innerText = 'Hazır!';
        
        aiStatus.innerText = "Sistem Hazır - İzleyici Bekleniyor...";
        
        setTimeout(() => {
            if (loadingContainer) loadingContainer.style.display = 'none';
        }, 500);

    } catch(err) {
        console.error('MediaPipe yükleme hatası:', err);
        aiStatus.innerText = "AI Yüklenemedi! GPU desteklenmiyor olabilir.";
        aiStatus.style.color = "#f44336";
        if (loadingText) loadingText.innerText = 'Hata: ' + err.message;
        
        // GPU başarısız olursa CPU ile dene
        try {
            if (loadingText) loadingText.innerText = 'CPU modu deneniyor...';
            const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
            const filesetResolver = await vision.FilesetResolver.forVisionTasks(
                'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
            );
            detector = await vision.ObjectDetector.createFromOptions(filesetResolver, {
                baseOptions: {
                    modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
                    delegate: 'CPU'
                },
                categoryAllowlist: ['person'],
                scoreThreshold: 0.40,
                maxResults: 10,
                runningMode: 'VIDEO'
            });
            aiStatus.innerText = "Sistem Hazır (CPU modu)";
            aiStatus.style.color = "#FF9800";
            if (loadingContainer) loadingContainer.style.display = 'none';
        } catch(err2) {
            console.error('CPU fallback hatası:', err2);
            return;
        }
    }
    
    video.addEventListener('loadedmetadata', () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    });
    
    detectFrame();
}

// =================== ALGILAMA DÖNGÜSÜ ===================
async function detectFrame() {
    if (!isCamera || !detector) return;
    
    const now = performance.now();
    
    if (video.readyState === 4 && !isDetecting) {
        isDetecting = true;
        
        if (canvas.width !== video.videoWidth && video.videoWidth > 0) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // MediaPipe detectForVideo: WASM ile süper hızlı!
        // Dahili olarak resmi optimize boyuta küçültür, offscreen canvas'a gerek yok
        const result = detector.detectForVideo(video, now);
        
        const videoArea = video.videoWidth * video.videoHeight;
        
        // Sonuçları filtrele ve bbox formatına çevir
        currentPeople = result.detections
            .filter(d => {
                const bb = d.boundingBox;
                // Çok küçük kutuları reddet
                if ((bb.width * bb.height) < (videoArea * MIN_BBOX_RATIO)) return false;
                // İnsan şekline uymayan kutuları reddet
                if (!isValidPersonShape(bb.width, bb.height)) return false;
                return true;
            })
            .map(d => ({
                bbox: [d.boundingBox.originX, d.boundingBox.originY, d.boundingBox.width, d.boundingBox.height],
                score: d.categories[0].score
            }));

        let targetFound = false;

        if (lockedTarget) {
            let bestMatch = null;
            let bestScore = -Infinity; 

            currentPeople.forEach(person => {
                const [x, y, w, h] = person.bbox;
                const iou = getIoU(lockedTarget.bbox, person.bbox);
                
                const centerX = x + w/2;
                const centerY = y + h/2;
                const dist = Math.hypot(centerX - lockedTarget.x, centerY - lockedTarget.y);
                
                const prevW = lockedTarget.bbox[2];
                const prevH = lockedTarget.bbox[3];
                const maxDim = Math.max(prevW, prevH) || 1;
                
                const distRatio = dist / maxDim;
                const currentArea = w * h;
                const prevArea = prevW * prevH;
                const sizeRatio = Math.min(currentArea, prevArea) / Math.max(currentArea, prevArea); 
                
                let score = (iou * 4.0) + (sizeRatio * 1.5) - (distRatio * 3.5);
                
                if ((iou > 0.1 || (distRatio < 1.0 && sizeRatio > 0.5)) && score > bestScore) {
                    bestScore = score;
                    bestMatch = person;
                }
            });

            if (bestScore < 0.3) {
                bestMatch = null;
            }

            if (bestMatch) {
                targetFound = true;
                const [x, y, w, h] = bestMatch.bbox;
                lockedTarget = { x: x + w/2, y: y + h/2, bbox: bestMatch.bbox };
                
                ctx.strokeStyle = '#00FF00'; 
                ctx.fillStyle = '#00FF00';
                ctx.lineWidth = 4;
                ctx.strokeRect(x, y, w, h);
                
                ctx.font = 'bold 22px Arial';
                ctx.fillText(`🎯 KİLİTLİ HEDEF`, x, y > 25 ? y - 10 : 25);
            }

            currentPeople.forEach(person => {
                if (person !== bestMatch) {
                    const [px, py, pw, ph] = person.bbox;
                    ctx.strokeStyle = 'rgba(255, 0, 0, 0.4)'; 
                    ctx.lineWidth = 2;
                    ctx.strokeRect(px, py, pw, ph);
                }
            });

        } else {
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

        // ALARM MANTIĞI
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
        
        // İzleyiciye tracking verisini gönder
        if (conn && conn.open) {
            conn.send({
                type: 'tracking_data',
                w: canvas.width,
                h: canvas.height,
                people: currentPeople.map(p => p.bbox),
                lockedTarget: lockedTarget ? lockedTarget.bbox : null,
                targetFound: targetFound
            });
        }
        
        isDetecting = false;
    }
    
    // MediaPipe çok hızlı olduğu için minimal bekleme yeterli
    // requestAnimationFrame zaten 60fps'e kilitli, AI ~15-25fps çalışacak
    requestAnimationFrame(detectFrame);
}

// =================== KAMERA MODU ===================
async function startCameraMode() {
    isCamera = true;
    document.getElementById('role-selection').style.display = 'none';
    document.getElementById('main').style.display = 'flex';
    document.getElementById('cam-controls').style.display = 'block';
    
    let stream;
    try {
        // 720p: Uzaktakileri görecek kadar net, hızlı çalışacak kadar hafif
        stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                facingMode: "environment", 
                width: { ideal: 1280 }, 
                height: { ideal: 720 } 
            }, 
            audio: false 
        });
        video.srcObject = stream;
        video.muted = true;
    } catch (err) {
        alert("Kamera Açılamadı veya İzin Verilmedi!");
        location.reload();
        return;
    }

    const shortCode = generateCode();
    const peerId = `phtrck-${shortCode}`;
    document.getElementById('my-code').innerText = shortCode;

    connStatus.innerText = "Sunucuya Kayıt Olunuyor...";
    pulse.className = 'pulse';

    peer = new Peer(peerId, { debug: 0 });
    
    peer.on('open', (id) => {
        connStatus.innerText = "Yayınla... İzleyici Bekleniyor!";
        pulse.className = 'pulse green';
        document.getElementById('lock-controls').style.display = 'block';
        loadModel(); // MediaPipe modelini yükle
    });

    peer.on('connection', (connection) => {
        conn = connection;
        connStatus.innerText = "İzleyici Bağlandı! (Aktif)";
        
        conn.on('data', (data) => {
            if(data.type === 'viewer_ready') {
                peer.call(conn.peer, stream);
            } else if (data.type === 'viewer_click') {
                const clickX = (data.x / data.w) * canvas.width;
                const clickY = (data.y / data.h) * canvas.height;
                
                for (let person of currentPeople) {
                    const [px, py, pw, ph] = person.bbox;
                    if (clickX >= px && clickX <= px + pw && clickY >= py && clickY <= py + ph) {
                        lockOnPerson(person);
                        break;
                    }
                }
            } else if (data.type === 'viewer_unlock') {
                window.unlockTarget();
            }
        });
        
        conn.on('close', () => {
            connStatus.innerText = "İzleyici Ayrıldı!";
        });
    });
}

// =================== İZLEYİCİ MODU ===================
function showViewerInput() {
    document.getElementById('role-selection').style.display = 'none';
    document.getElementById('viewer-setup').style.display = 'flex';
}

function connectToCamera() {
    const code = document.getElementById('join-code').value.trim();
    if(code.length !== 5) { alert("Lütfen 5 Haneli Kodu Eksiksiz Girin!"); return; }

    document.getElementById('viewer-setup').style.display = 'none';
    document.getElementById('main').style.display = 'flex';
    document.getElementById('cam-controls').style.display = 'none';
    document.getElementById('lock-controls').style.display = 'block';
    isCamera = false;
    
    video.muted = true;

    connStatus.innerText = "Bağlanılıyor...";
    aiStatus.innerText = "Görüntü Bekleniyor";
    pulse.className = 'pulse';

    peer = new Peer({ debug: 0 });

    peer.on('open', (id) => {
        const targetPeerId = `phtrck-${code}`;
        
        conn = peer.connect(targetPeerId);
        
        conn.on('open', () => {
            connStatus.innerText = "Bağlandı!";
            pulse.className = 'pulse green';
            conn.send({ type: 'viewer_ready' });
        });

        conn.on('data', handleAlertData);
        
        conn.on('close', () => {
            connStatus.innerText = "Bağlantı Koptu!";
            pulse.className = 'pulse';
            if(isAlerting) clearAlertDisplay();
        });
    });

    peer.on('call', (incomingCall) => {
        call = incomingCall;
        call.answer();
        
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

// =================== İZLEYİCİ ÇİZİM ===================
function viewerDrawBoxes(data) {
    if (isCamera) return;
    
    if (canvas.width !== video.videoWidth && video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    }
    if (canvas.width === 0 || canvas.height === 0) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const scaleX = canvas.width / data.w;
    const scaleY = canvas.height / data.h;
    
    if (data.lockedTarget) {
        const [x, y, w, h] = data.lockedTarget;
        const mx = x * scaleX, my = y * scaleY, mw = w * scaleX, mh = h * scaleY;
        
        ctx.strokeStyle = '#00FF00'; 
        ctx.fillStyle = '#00FF00';
        ctx.lineWidth = 4;
        ctx.strokeRect(mx, my, mw, mh);
        
        ctx.font = 'bold 22px Arial';
        ctx.fillText(`🎯 KİLİTLİ HEDEF`, mx, my > 25 ? my - 10 : 25);
        document.getElementById('unlockBtn').style.display = 'block';
    } else {
        data.people.forEach(bbox => {
            const [x, y, w, h] = bbox;
            const mx = x * scaleX, my = y * scaleY, mw = w * scaleX, mh = h * scaleY;
            
            ctx.strokeStyle = '#00bcd4'; 
            ctx.fillStyle = '#00bcd4';
            ctx.lineWidth = 3;
            ctx.strokeRect(mx, my, mw, mh);
            
            ctx.font = '18px Arial';
            ctx.fillText(`👆 Dokun`, mx, my > 20 ? my - 10 : 20);
            
            ctx.beginPath();
            ctx.arc(mx + mw/2, my + mh/2, 8, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(0, 188, 212, 0.6)';
            ctx.fill();
        });
        document.getElementById('unlockBtn').style.display = 'none';
    }
}

// =================== ALARM SİSTEMİ ===================
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
    } else if (data.type === 'tracking_data') {
        viewerDrawBoxes(data);
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

// =================== GLOBAL FONKSİYONLAR ===================
// type="module" ile yüklenen script'lerde onclick="..." çalışması için
// fonksiyonları window'a bağlıyoruz
window.startCameraMode = startCameraMode;
window.showViewerInput = showViewerInput;
window.connectToCamera = connectToCamera;
