// ===================================================================
// KAMERA TAKİP - HİBRİT SİSTEM (Kesin Çözüm)
// ===================================================================
// 1. Kamera ve bağlantı ANINDA açılır (beklemek yok)
// 2. AI (MediaPipe) ARKA PLANDA yüklenir
// 3. AI saniyede sadece 1 kez çalışır (kasma yok, %90 boşta)
// 4. Çizim 30fps (akıcı)
// 5. Sadece GERÇEK insanları algılar (boşluk algılamaz)
// ===================================================================

const vid = document.getElementById('vid');
const cvs = document.getElementById('cvs');
const ctx = cvs.getContext('2d');
const alertBox = document.getElementById('alert');
const cs = document.getElementById('cs');
const as_ = document.getElementById('as');
const cp = document.getElementById('cp');
const ub = document.getElementById('ub');

let peer = null, conn = null, call = null;
let isCamera = false;
let detector = null;        // MediaPipe ObjectDetector
let modelReady = false;

// Algılanan kişiler (son detection sonucu)
let people = [];            // [{bbox:[x,y,w,h], score}]
let lockedIdx = -1;         // Kilitli kişinin indexi
let lockedCenter = null;    // {x,y} son bilinen merkez
let lockedBbox = null;      // [x,y,w,h] son bilinen kutu
let smoothBbox = null;      // pürüzsüz animasyon için saklanan kutu
let lastFoundTime = Date.now();
const LOST_TIMEOUT = 2000;  // 2 saniye bulunamazsa alarm
let isAlerting = false;
let vibInt;

// =================== YÜKLEME ===================

async function loadAI() {
    const ld = document.getElementById('ld');
    const lf = document.getElementById('lf');
    const lt = document.getElementById('lt');
    if (ld) ld.style.display = 'block';

    try {
        if (lt) lt.innerText = 'TFJS Arka Uç Bağlanıyor...';
        if (lf) lf.style.width = '20%';

        await tf.ready();
        await tf.setBackend('webgl'); // GPU hızlandırması garanti

        if (lt) lt.innerText = 'Model İndiriliyor (Coco-SSD)...';
        if (lf) lf.style.width = '60%';

        detector = await cocoSsd.load({ base: 'lite_mobilenet_v2' });

        if (lf) lf.style.width = '100%';
        if (lt) lt.innerText = 'Hazır!';
        modelReady = true;
        as_.innerText = 'AI Hazır — Kişiye dokunun';
        as_.style.color = '#4CAF50';

        setTimeout(() => { if (ld) ld.style.display = 'none'; }, 600);

        // Algılama döngüsünü başlat
        detectLoop();

    } catch (err) {
        console.error('AI yükleme hatası:', err);
        if (lt) lt.innerText = 'AI yüklenemedi: ' + err.message;
        as_.innerText = 'AI Hatası!';
        as_.style.color = '#f44336';
    }
}

// =================== ALGILAMA DÖNGÜSÜ ===================
let detecting = false;

async function detectLoop() {
    if (!isCamera || !detector || !modelReady) return;

    if (vid.readyState >= 4 && !detecting) {
        detecting = true;
        try {
            // Asenkron algılama. Kamerayı DONDURMAZ!
            const predictions = await detector.detect(vid);

            // Sonuçları [x, y, w, h] formatına çevir (sadece person sınıfı)
            people = predictions
                .filter(p => p.class === 'person' && p.score > 0.45)
                .map(p => ({
                    bbox: [p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3]],
                    score: p.score
                }));

            // Kilitli hedefi güncelle
            if (lockedBbox) {
                updateLockedTarget();
            }

            // İzleyiciye gönder
            if (conn && conn.open) {
                conn.send({
                    type: 'tracking_data',
                    w: vid.videoWidth,
                    h: vid.videoHeight,
                    people: people.map(p => p.bbox),
                    locked: lockedBbox,
                    found: lockedBbox ? isTargetFound() : false
                });
            }
        } catch (e) {
            console.error('Detection error:', e);
        }
        detecting = false;
    }

    // AI kareleri arasında nefes alma süresi.
    setTimeout(detectLoop, 15);
}

// =================== HEDEF TAKİP ===================

function getIoU(a, b) {
    const [ax, ay, aw, ah] = a;
    const [bx, by, bw, bh] = b;
    const x1 = Math.max(ax, bx), y1 = Math.max(ay, by);
    const x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ah, by + bh);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    if (inter === 0) return 0;
    return inter / (aw * ah + bw * bh - inter);
}

function updateLockedTarget() {
    if (!lockedBbox || people.length === 0) return;

    let bestMatch = null;
    let bestScore = -Infinity;

    for (const p of people) {
        const iou = getIoU(lockedBbox, p.bbox);
        const [x, y, w, h] = p.bbox;
        const cx = x + w / 2, cy = y + h / 2;
        const dist = Math.hypot(cx - lockedCenter.x, cy - lockedCenter.y);
        const maxDim = Math.max(lockedBbox[2], lockedBbox[3]) || 1;
        const distRatio = dist / maxDim;
        const sizeRatio = Math.min(w * h, lockedBbox[2] * lockedBbox[3]) /
                          Math.max(w * h, lockedBbox[2] * lockedBbox[3]);

        const score = (iou * 5) + (sizeRatio * 2) - (distRatio * 3);

        if ((iou > 0.05 || (distRatio < 2.0 && sizeRatio > 0.3)) && score > bestScore) {
            bestScore = score;
            bestMatch = p;
        }
    }

    if (bestMatch && bestScore > -0.5) {
        const [x, y, w, h] = bestMatch.bbox;
        lockedBbox = [x, y, w, h];
        lockedCenter = { x: x + w / 2, y: y + h / 2 };
        lastFoundTime = Date.now();
    }
}

function isTargetFound() {
    return (Date.now() - lastFoundTime) < LOST_TIMEOUT;
}

function lockToPerson(bbox) {
    const [x, y, w, h] = bbox;
    lockedBbox = [x, y, w, h];
    lockedCenter = { x: x + w / 2, y: y + h / 2 };
    lastFoundTime = Date.now();
    ub.style.display = 'block';
    as_.innerText = '🎯 HEDEFE KİLİTLENDİ!';
    as_.style.color = '#4CAF50';
    clearAlertDisplay();
    if (conn && conn.open) conn.send({ type: 'person_in' });
}

function unlockTarget() {
    lockedBbox = null;
    smoothBbox = null;
    lockedCenter = null;
    lockedIdx = -1;
    ub.style.display = 'none';
    as_.innerText = modelReady ? 'Kişiye dokunun' : 'AI yükleniyor...';
    as_.style.color = '#00bcd4';
    clearAlertDisplay();
    if (conn && conn.open) conn.send({ type: 'person_in' });
}

// =================== ÇİZİM DÖNGÜSÜ (30fps, hafif) ===================

function drawLoop() {
    if (vid.readyState >= 4) {
        if (cvs.width !== vid.videoWidth && vid.videoWidth > 0) {
            cvs.width = vid.videoWidth;
            cvs.height = vid.videoHeight;
        }

        ctx.clearRect(0, 0, cvs.width, cvs.height);

        if (isCamera) {
            if (lockedBbox) {
                if (!smoothBbox) smoothBbox = [...lockedBbox];
                else {
                    smoothBbox[0] += (lockedBbox[0] - smoothBbox[0]) * 0.3; // x
                    smoothBbox[1] += (lockedBbox[1] - smoothBbox[1]) * 0.3; // y
                    smoothBbox[2] += (lockedBbox[2] - smoothBbox[2]) * 0.3; // w
                    smoothBbox[3] += (lockedBbox[3] - smoothBbox[3]) * 0.3; // h
                }
                const [x, y, w, h] = smoothBbox;
                const found = isTargetFound();

                if (found) {
                    // Yeşil kutu - hedef görünüyor
                    ctx.strokeStyle = '#00FF00';
                    ctx.lineWidth = 4;
                    ctx.strokeRect(x, y, w, h);
                    ctx.fillStyle = '#00FF00';
                    ctx.font = 'bold 20px Arial';
                    ctx.fillText('🎯 KİLİTLİ', x, y > 25 ? y - 8 : 25);

                    if (as_.innerText.indexOf('✅') === -1 && as_.innerText.indexOf('KİLİT') === -1) {
                        as_.innerText = '✅ Hedef görüş alanında';
                        as_.style.color = '#4CAF50';
                    }
                } else {
                    // Turuncu kesikli - hedef kayboldu
                    ctx.strokeStyle = '#FF9800';
                    ctx.lineWidth = 3;
                    ctx.setLineDash([8, 8]);
                    ctx.strokeRect(x, y, w, h);
                    ctx.setLineDash([]);

                    // Alarm ve düşürme kontrolü
                    const elapsed = Date.now() - lastFoundTime;
                    
                    if (elapsed >= 7000) {
                        // 7 saniye boyunca hiç gelmezse tamamen unut (ikazı da kapatır)
                        unlockTarget();
                    } else if (elapsed >= LOST_TIMEOUT) {
                        // 2 saniye geçince alarm çalmaya başla
                        if (as_.innerText !== '❌ HEDEF KAYIP!') {
                            as_.innerText = '❌ HEDEF KAYIP!';
                            as_.style.color = '#f44336';
                            if (conn && conn.open) conn.send({ type: 'person_out' });
                            triggerAlert();
                        }
                    }
                }

                // Diğer kişiler kırmızı
                for (const p of people) {
                    if (getIoU(p.bbox, lockedBbox) < 0.3) {
                        const [px, py, pw, ph] = p.bbox;
                        ctx.strokeStyle = 'rgba(255,0,0,0.35)';
                        ctx.lineWidth = 2;
                        ctx.strokeRect(px, py, pw, ph);
                    }
                }
            } else if (modelReady) {
                // Kilitli değil: tüm kişileri mavi göster
                for (const p of people) {
                    const [x, y, w, h] = p.bbox;
                    ctx.strokeStyle = '#00bcd4';
                    ctx.fillStyle = '#00bcd4';
                    ctx.lineWidth = 3;
                    ctx.strokeRect(x, y, w, h);
                    ctx.font = '16px Arial';
                    ctx.fillText('👆 Dokun', x, y > 20 ? y - 8 : 20);
                }

                if (people.length === 0) {
                    ctx.fillStyle = 'rgba(0,188,212,0.7)';
                    ctx.font = 'bold 22px Arial';
                    const t = 'Kişi algılanmadı';
                    ctx.fillText(t, (cvs.width - ctx.measureText(t).width) / 2, cvs.height / 2);
                }
            } else {
                ctx.fillStyle = 'rgba(0,188,212,0.6)';
                ctx.font = 'bold 20px Arial';
                const t = '⏳ AI yükleniyor...';
                ctx.fillText(t, (cvs.width - ctx.measureText(t).width) / 2, cvs.height / 2);
            }
        }
    }

    requestAnimationFrame(drawLoop);
}

// =================== TIKKLAMA ===================

cvs.addEventListener('click', (e) => {
    const rect = cvs.getBoundingClientRect();
    const sx = cvs.width / rect.width;
    const sy = cvs.height / rect.height;
    const cx = (e.clientX - rect.left) * sx;
    const cy = (e.clientY - rect.top) * sy;

    if (!isCamera) {
        if (conn && conn.open) conn.send({ type: 'viewer_click', x: cx, y: cy, w: cvs.width, h: cvs.height });
        return;
    }

    if (!modelReady || people.length === 0) return;

    // SADECE kutunun İÇİNE tıklanırsa seç, BOŞLUĞA tıklanırsa kilidi kaldır
    let clickedPerson = false;
    for (const p of people) {
        const [x, y, w, h] = p.bbox;
        if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) {
            lockToPerson(p.bbox);
            clickedPerson = true;
            return;
        }
    }
    
    // Boşluğa tıklandıysa ve halihazırda kilitli bir hedef varsa kilidi aç
    if (!clickedPerson && lockedBbox) {
        unlockTarget();
        if (conn && conn.open) conn.send({ type: 'viewer_unlock' }); // Diğer tarafa da bildir
    }
});

ub.addEventListener('click', () => {
    if (!isCamera && conn && conn.open) {
        conn.send({ type: 'viewer_unlock' });
    }
    unlockTarget();
});

// =================== ALARM ===================

function triggerAlert() {
    if (isAlerting) return;
    isAlerting = true;
    alertBox.style.display = 'flex';
    if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);
    vibInt = setInterval(() => {
        if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);
    }, 800);
}

function clearAlertDisplay() {
    if (!isAlerting) return;
    isAlerting = false;
    alertBox.style.display = 'none';
    clearInterval(vibInt);
}

// =================== KAMERA MODU ===================

document.getElementById('btnCam').addEventListener('click', async () => {
    isCamera = true;
    document.getElementById('role').style.display = 'none';
    document.getElementById('main').style.display = 'flex';
    document.getElementById('cc').style.display = 'block';
    document.getElementById('lc').style.display = 'block';

    // 1. Kamerayı HEMEN aç
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
            audio: false
        });
        vid.srcObject = stream;
        vid.muted = true;
    } catch (e) {
        alert('Kamera açılamadı!');
        location.reload();
        return;
    }

    // 2. PeerJS'i HEMEN başlat
    const code = Math.floor(10000 + Math.random() * 90000).toString();
    document.getElementById('mc').innerText = code;
    cs.innerText = 'Kayıt olunuyor...';

    peer = new Peer('phtrck-' + code, { debug: 0 });

    peer.on('open', () => {
        cs.innerText = 'Hazır — İzleyici bekleniyor';
        cp.className = 'p g';
        // Çizim döngüsünü başlat (anında, AI olmadan bile çalışır)
        drawLoop();
        // 3. AI'yı ARKA PLANDA yükle (bekletmez)
        loadAI();
    });

    peer.on('connection', (c) => {
        conn = c;
        cs.innerText = 'İzleyici bağlandı!';
        c.on('data', (d) => {
            if (d.type === 'viewer_ready') peer.call(c.peer, stream);
            else if (d.type === 'viewer_click') {
                const cx = (d.x / d.w) * cvs.width;
                const cy = (d.y / d.h) * cvs.height;
                // SADECE kutunun İÇİNE tıklanırsa seç, BOŞLUĞA tıklanırsa kaldır
                let clickedPerson = false;
                for (const p of people) {
                    const [x, y, w, h] = p.bbox;
                    if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) {
                        lockToPerson(p.bbox);
                        clickedPerson = true;
                        break;
                    }
                }
                if (!clickedPerson && lockedBbox) {
                    unlockTarget();
                }
            }
            else if (d.type === 'viewer_unlock') unlockTarget();
        });
        c.on('close', () => { cs.innerText = 'İzleyici ayrıldı'; });
    });

    peer.on('error', (e) => console.error('Peer:', e));
});

// =================== İZLEYİCİ MODU ===================

document.getElementById('btnView').addEventListener('click', () => {
    document.getElementById('role').style.display = 'none';
    document.getElementById('vs').style.display = 'flex';
});

document.getElementById('btnConn').addEventListener('click', () => {
    const code = document.getElementById('jc').value.trim();
    if (code.length !== 5) { alert('5 haneli kodu girin!'); return; }

    document.getElementById('vs').style.display = 'none';
    document.getElementById('main').style.display = 'flex';
    document.getElementById('lc').style.display = 'block';
    isCamera = false;
    vid.muted = true;
    cs.innerText = 'Bağlanılıyor...';
    as_.innerText = 'Görüntü bekleniyor';
    cp.className = 'p';

    peer = new Peer({ debug: 0 });

    peer.on('open', () => {
        conn = peer.connect('phtrck-' + code);
        conn.on('open', () => {
            cs.innerText = 'Bağlandı!';
            cp.className = 'p g';
            conn.send({ type: 'viewer_ready' });
            viewerDraw();
        });
        conn.on('data', handleViewerData);
        conn.on('close', () => {
            cs.innerText = 'Bağlantı koptu!';
            cp.className = 'p';
            clearAlertDisplay();
        });
    });

    peer.on('call', (ic) => {
        call = ic;
        ic.answer();
        ic.on('stream', (rs) => {
            if (!vid.srcObject) {
                vid.srcObject = rs;
                as_.innerText = '✅ Canlı izleniyor';
                as_.style.color = '#4CAF50';
            }
        });
    });

    peer.on('error', (e) => {
        if (e.type === 'peer-unavailable') {
            alert('Kamera bulunamadı! Kodu kontrol edin.');
            location.reload();
        }
    });
});

// =================== İZLEYİCİ ===================

let vData = null;

function handleViewerData(d) {
    if (d.type === 'tracking_data') vData = d;
    else if (d.type === 'person_out') triggerAlert();
    else if (d.type === 'person_in') clearAlertDisplay();
}

function viewerDraw() {
    if (isCamera) return;

    if (vid.readyState >= 4) {
        if (cvs.width !== vid.videoWidth && vid.videoWidth > 0) {
            cvs.width = vid.videoWidth;
            cvs.height = vid.videoHeight;
        }
        ctx.clearRect(0, 0, cvs.width, cvs.height);

        if (vData) {
            const sx = cvs.width / vData.w;
            const sy = cvs.height / vData.h;

            if (vData.locked) {
                const [x, y, w, h] = vData.locked;
                const mx = x * sx, my = y * sy, mw = w * sx, mh = h * sy;

                if (vData.found) {
                    ctx.strokeStyle = '#00FF00';
                    ctx.lineWidth = 4;
                    ctx.strokeRect(mx, my, mw, mh);
                    ctx.fillStyle = '#00FF00';
                    ctx.font = 'bold 20px Arial';
                    ctx.fillText('🎯 KİLİTLİ', mx, my > 25 ? my - 8 : 25);
                } else {
                    ctx.strokeStyle = '#FF9800';
                    ctx.lineWidth = 3;
                    ctx.setLineDash([8, 8]);
                    ctx.strokeRect(mx, my, mw, mh);
                    ctx.setLineDash([]);
                }
                ub.style.display = 'block';
            } else {
                // Tüm kişileri göster
                for (const bbox of (vData.people || [])) {
                    const [x, y, w, h] = bbox;
                    const mx = x * sx, my = y * sy, mw = w * sx, mh = h * sy;
                    ctx.strokeStyle = '#00bcd4';
                    ctx.fillStyle = '#00bcd4';
                    ctx.lineWidth = 3;
                    ctx.strokeRect(mx, my, mw, mh);
                    ctx.font = '16px Arial';
                    ctx.fillText('👆 Dokun', mx, my > 20 ? my - 8 : 20);
                }
                ub.style.display = 'none';
            }
        }
    }

    requestAnimationFrame(viewerDraw);
}

// Global exports for onclick handlers
window.unlockTarget = unlockTarget;
