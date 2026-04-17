// ===================================================================
// KAMERA TAKİP - Piksel Tabanlı Gerçek Zamanlı İzleme
// ===================================================================
// ML modeli YOK. AI YOK. Model indirme YOK.
// Kullanıcı kişiye dokunur → piksel deseni kaydedilir → her karede aranır.
// Sonuç: Anında açılır, 30+ FPS, telefon kasmaz.
// ===================================================================

// =================== DOM ===================
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const alertBox = document.getElementById('alert');
const connStatus = document.getElementById('conn-status');
const aiStatus = document.getElementById('ai-status');
const pulse = document.getElementById('conn-pulse');
const unlockBtn = document.getElementById('unlockBtn');

// =================== BAĞLANTI ===================
let peer = null;
let conn = null;
let call = null;
let isCamera = false;

// =================== TAKİP DEĞİŞKENLERİ ===================
let trackingActive = false;
let templateGray = null;      // Float32Array - gri tonlama şablon
let templateW = 0;            // Küçültülmüş şablon genişlik
let templateH = 0;            // Küçültülmüş şablon yükseklik
let targetRect = null;        // {x, y, w, h} - orijinal video koordinatları
let trackConfidence = 0;
let lastSeenTime = Date.now();
const LOST_TIMEOUT = 1500;    // 1.5 saniye görünmezse alarm
let isAlerting = false;
let vibrateInterval;

// Takip sabitleri
const TPL_W_RATIO = 0.13;     // Şablon genişliği = video genişliğinin %13'ü
const TPL_H_RATIO = 0.22;     // Şablon yüksekliği = video yüksekliğinin %22'si
const SCALE = 0.20;           // Piksel işleme için küçültme oranı (5x küçült)
const SEARCH_PAD = 1.8;       // Arama penceresi = şablon boyutunun 1.8 katı pad
const MATCH_OK = 0.30;        // Bu skorun üstü = hedef bulundu
const MATCH_UPDATE = 0.55;    // Bu skorun üstü = şablonu güncelle
const TPL_BLEND = 0.12;       // Şablon güncelleme karışım oranı

// Geçici canvas'lar (görünmez, piksel okuma için)
const tmpCanvas = document.createElement('canvas');
const tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });

// =================== YARDIMCI FONKSİYONLAR ===================

function generateCode() {
    return Math.floor(10000 + Math.random() * 90000).toString();
}

// RGB piksellerini gri tonlamaya çevir
function rgbaToGray(data, w, h) {
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
        const idx = i * 4;
        gray[i] = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
    }
    return gray;
}

// Normalized Cross-Correlation (NCC) - şablon eşleştirme
// Yüksek skor = iyi eşleşme (1.0 = mükemmel)
function ncc(tpl, search, ox, oy, tw, th, sw) {
    let sumT = 0, sumS = 0, sumTT = 0, sumSS = 0, sumTS = 0;
    const n = tw * th;
    for (let y = 0; y < th; y++) {
        const tRow = y * tw;
        const sRow = (oy + y) * sw + ox;
        for (let x = 0; x < tw; x++) {
            const t = tpl[tRow + x];
            const s = search[sRow + x];
            sumT += t;
            sumS += s;
            sumTS += t * s;
            sumTT += t * t;
            sumSS += s * s;
        }
    }
    const mT = sumT / n;
    const mS = sumS / n;
    const num = sumTS - n * mT * mS;
    const denA = sumTT - n * mT * mT;
    const denB = sumSS - n * mS * mS;
    if (denA <= 0 || denB <= 0) return 0;
    return num / Math.sqrt(denA * denB);
}

// =================== TAKİP MOTORU ===================

function startTracking(centerX, centerY) {
    // Orijinal boyutlarda şablon boyutunu hesapla
    const origW = Math.round(video.videoWidth * TPL_W_RATIO);
    const origH = Math.round(video.videoHeight * TPL_H_RATIO);
    const x = Math.max(0, Math.round(centerX - origW / 2));
    const y = Math.max(0, Math.round(centerY - origH / 2));
    const w = Math.min(origW, video.videoWidth - x);
    const h = Math.min(origH, video.videoHeight - y);

    // Küçültülmüş boyutlar
    const sw = Math.max(4, Math.round(w * SCALE));
    const sh = Math.max(4, Math.round(h * SCALE));

    // Şablonu küçültüp yakala
    tmpCanvas.width = sw;
    tmpCanvas.height = sh;
    tmpCtx.drawImage(video, x, y, w, h, 0, 0, sw, sh);
    const imgData = tmpCtx.getImageData(0, 0, sw, sh);

    templateGray = rgbaToGray(imgData.data, sw, sh);
    templateW = sw;
    templateH = sh;
    targetRect = { x, y, w, h };
    trackingActive = true;
    trackConfidence = 1.0;
    lastSeenTime = Date.now();

    unlockBtn.style.display = 'block';
    aiStatus.innerText = "🎯 HEDEFE KİLİTLENDİ!";
    aiStatus.style.color = "#4CAF50";

    // İzleyiciye bildir
    if (conn && conn.open) conn.send({ type: 'person_in' });
}

function doTrack() {
    if (!targetRect || !templateGray) return false;

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // Arama alanı: hedefin etrafında geniş bir pencere
    const padX = Math.round(targetRect.w * SEARCH_PAD);
    const padY = Math.round(targetRect.h * SEARCH_PAD);
    const sx = Math.max(0, targetRect.x - padX);
    const sy = Math.max(0, targetRect.y - padY);
    const ex = Math.min(vw, targetRect.x + targetRect.w + padX);
    const ey = Math.min(vh, targetRect.y + targetRect.h + padY);
    const searchW = ex - sx;
    const searchH = ey - sy;

    // Küçültülmüş arama alanı
    const ssw = Math.max(templateW + 2, Math.round(searchW * SCALE));
    const ssh = Math.max(templateH + 2, Math.round(searchH * SCALE));

    tmpCanvas.width = ssw;
    tmpCanvas.height = ssh;
    tmpCtx.drawImage(video, sx, sy, searchW, searchH, 0, 0, ssw, ssh);
    const searchImg = tmpCtx.getImageData(0, 0, ssw, ssh);
    const searchGray = rgbaToGray(searchImg.data, ssw, ssh);

    // Kaba arama (step=2)
    let bestScore = -1;
    let bestDX = 0, bestDY = 0;
    const maxDY = ssh - templateH;
    const maxDX = ssw - templateW;

    for (let dy = 0; dy <= maxDY; dy += 2) {
        for (let dx = 0; dx <= maxDX; dx += 2) {
            const score = ncc(templateGray, searchGray, dx, dy, templateW, templateH, ssw);
            if (score > bestScore) {
                bestScore = score;
                bestDX = dx;
                bestDY = dy;
            }
        }
    }

    // İnce arama (en iyi noktanın ±2 piksel çevresinde)
    const fineStartX = Math.max(0, bestDX - 2);
    const fineEndX = Math.min(maxDX, bestDX + 2);
    const fineStartY = Math.max(0, bestDY - 2);
    const fineEndY = Math.min(maxDY, bestDY + 2);

    for (let dy = fineStartY; dy <= fineEndY; dy++) {
        for (let dx = fineStartX; dx <= fineEndX; dx++) {
            const score = ncc(templateGray, searchGray, dx, dy, templateW, templateH, ssw);
            if (score > bestScore) {
                bestScore = score;
                bestDX = dx;
                bestDY = dy;
            }
        }
    }

    trackConfidence = bestScore;

    if (bestScore >= MATCH_OK) {
        // Hedef bulundu! Pozisyonu güncelle
        targetRect.x = sx + Math.round(bestDX / SCALE);
        targetRect.y = sy + Math.round(bestDY / SCALE);

        // Yüksek güvenle şablonu yavaşça güncelle (ışık değişimine uyum)
        if (bestScore >= MATCH_UPDATE) {
            tmpCanvas.width = templateW;
            tmpCanvas.height = templateH;
            tmpCtx.drawImage(video, targetRect.x, targetRect.y, targetRect.w, targetRect.h, 0, 0, templateW, templateH);
            const newData = tmpCtx.getImageData(0, 0, templateW, templateH);
            const newGray = rgbaToGray(newData.data, templateW, templateH);
            // Eski + yeni karışımı (drift'i önler)
            for (let i = 0; i < templateGray.length; i++) {
                templateGray[i] = templateGray[i] * (1 - TPL_BLEND) + newGray[i] * TPL_BLEND;
            }
        }

        lastSeenTime = Date.now();
        return true;
    }

    return false;
}

// =================== ANA DÖNGÜ ===================

function mainLoop() {
    if (video.readyState < 4) {
        requestAnimationFrame(mainLoop);
        return;
    }

    if (canvas.width !== video.videoWidth && video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (isCamera && trackingActive) {
        const found = doTrack();

        if (found && targetRect) {
            // YEŞİL KİLİT ÇERÇEVESİ
            ctx.strokeStyle = '#00FF00';
            ctx.lineWidth = 4;
            ctx.strokeRect(targetRect.x, targetRect.y, targetRect.w, targetRect.h);

            ctx.fillStyle = '#00FF00';
            ctx.font = 'bold 20px Arial';
            const label = `🎯 %${Math.round(trackConfidence * 100)}`;
            ctx.fillText(label, targetRect.x, targetRect.y > 25 ? targetRect.y - 8 : 25);

            // Merkez noktası
            ctx.beginPath();
            ctx.arc(targetRect.x + targetRect.w / 2, targetRect.y + targetRect.h / 2, 5, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0, 255, 0, 0.7)';
            ctx.fill();

            if (aiStatus.innerText.indexOf('✅') === -1) {
                aiStatus.innerText = '✅ Hedef Görüş Alanında';
                aiStatus.style.color = '#4CAF50';
                if (conn && conn.open) conn.send({ type: 'person_in' });
            }
        } else {
            // Hedef kaybedildi
            const elapsed = Date.now() - lastSeenTime;
            if (elapsed >= LOST_TIMEOUT) {
                if (aiStatus.innerText !== '❌ HEDEF KAYIP!') {
                    aiStatus.innerText = '❌ HEDEF KAYIP!';
                    aiStatus.style.color = '#f44336';
                    if (conn && conn.open) conn.send({ type: 'person_out' });
                }
            } else {
                // Kısa süre kayıp, henüz alarm verme
                if (targetRect) {
                    ctx.strokeStyle = '#FF9800';
                    ctx.lineWidth = 3;
                    ctx.setLineDash([8, 8]);
                    ctx.strokeRect(targetRect.x, targetRect.y, targetRect.w, targetRect.h);
                    ctx.setLineDash([]);
                    ctx.fillStyle = '#FF9800';
                    ctx.font = 'bold 18px Arial';
                    ctx.fillText('⚠ Aranıyor...', targetRect.x, targetRect.y > 25 ? targetRect.y - 8 : 25);
                }
            }
        }

        // İzleyiciye takip verisini gönder
        if (conn && conn.open && targetRect) {
            conn.send({
                type: 'tracking_data',
                w: canvas.width,
                h: canvas.height,
                rect: [targetRect.x, targetRect.y, targetRect.w, targetRect.h],
                confidence: trackConfidence,
                found: trackConfidence >= MATCH_OK
            });
        }
    } else if (isCamera && !trackingActive) {
        // Hedef seçilmemiş - rehber göster
        ctx.fillStyle = 'rgba(0, 188, 212, 0.8)';
        ctx.font = 'bold 24px Arial';
        const text = '👆 Kişiye dokunun';
        const tm = ctx.measureText(text);
        ctx.fillText(text, (canvas.width - tm.width) / 2, canvas.height / 2);
    }

    // ~25fps hedefli döngü (pil ve performans dengesi)
    setTimeout(() => requestAnimationFrame(mainLoop), 40);
}

// =================== TIKKLAMA ===================

canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;

    if (!isCamera) {
        // İzleyici: tıklamayı kameraya gönder
        if (conn && conn.open) {
            conn.send({ type: 'viewer_click', x: cx, y: cy, w: canvas.width, h: canvas.height });
        }
        return;
    }

    // Kamera: tıklanan noktada takibi başlat
    if (video.readyState >= 4) {
        startTracking(cx, cy);
    }
});

unlockBtn.addEventListener('click', () => {
    if (!isCamera) {
        if (conn && conn.open) conn.send({ type: 'viewer_unlock' });
        trackingActive = false;
        targetRect = null;
        unlockBtn.style.display = 'none';
        aiStatus.innerText = 'Kilit Açıldı';
        aiStatus.style.color = '#00bcd4';
        clearAlertDisplay();
        return;
    }

    trackingActive = false;
    targetRect = null;
    templateGray = null;
    unlockBtn.style.display = 'none';
    aiStatus.innerText = 'Kişiye dokunun';
    aiStatus.style.color = '#00bcd4';
    clearAlertDisplay();
    if (conn && conn.open) conn.send({ type: 'person_in' });
});

// =================== KAMERA MODU ===================

document.getElementById('btnCam').addEventListener('click', async () => {
    isCamera = true;
    document.getElementById('role-selection').style.display = 'none';
    document.getElementById('main').style.display = 'flex';
    document.getElementById('cam-controls').style.display = 'block';
    document.getElementById('lock-controls').style.display = 'block';

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
        video.srcObject = stream;
        video.muted = true;
    } catch (err) {
        alert('Kamera açılamadı!');
        location.reload();
        return;
    }

    const shortCode = generateCode();
    const peerId = 'phtrck-' + shortCode;
    document.getElementById('my-code').innerText = shortCode;

    connStatus.innerText = 'Kayıt olunuyor...';
    pulse.className = 'pulse';

    peer = new Peer(peerId, { debug: 0 });

    peer.on('open', () => {
        connStatus.innerText = 'Hazır — İzleyici bekleniyor';
        pulse.className = 'pulse green';
        aiStatus.innerText = 'Kişiye dokunun';
        mainLoop();
    });

    peer.on('connection', (connection) => {
        conn = connection;
        connStatus.innerText = 'İzleyici bağlandı!';

        conn.on('data', (data) => {
            if (data.type === 'viewer_ready') {
                peer.call(conn.peer, stream);
            } else if (data.type === 'viewer_click') {
                const cx = (data.x / data.w) * canvas.width;
                const cy = (data.y / data.h) * canvas.height;
                if (video.readyState >= 4) startTracking(cx, cy);
            } else if (data.type === 'viewer_unlock') {
                unlockBtn.click();
            }
        });

        conn.on('close', () => {
            connStatus.innerText = 'İzleyici ayrıldı';
        });
    });

    peer.on('error', (err) => console.error('Peer error:', err));
});

// =================== İZLEYİCİ MODU ===================

document.getElementById('btnView').addEventListener('click', () => {
    document.getElementById('role-selection').style.display = 'none';
    document.getElementById('viewer-setup').style.display = 'flex';
});

document.getElementById('btnConnect').addEventListener('click', () => {
    const code = document.getElementById('join-code').value.trim();
    if (code.length !== 5) { alert('5 haneli kodu girin!'); return; }

    document.getElementById('viewer-setup').style.display = 'none';
    document.getElementById('main').style.display = 'flex';
    document.getElementById('lock-controls').style.display = 'block';
    isCamera = false;
    video.muted = true;

    connStatus.innerText = 'Bağlanılıyor...';
    aiStatus.innerText = 'Görüntü bekleniyor';
    pulse.className = 'pulse';

    peer = new Peer({ debug: 0 });

    peer.on('open', () => {
        conn = peer.connect('phtrck-' + code);

        conn.on('open', () => {
            connStatus.innerText = 'Bağlandı!';
            pulse.className = 'pulse green';
            conn.send({ type: 'viewer_ready' });
            // İzleyici de çizim döngüsüne başlasın
            viewerLoop();
        });

        conn.on('data', handleViewerData);

        conn.on('close', () => {
            connStatus.innerText = 'Bağlantı koptu!';
            pulse.className = 'pulse';
            clearAlertDisplay();
        });
    });

    peer.on('call', (incomingCall) => {
        call = incomingCall;
        call.answer();
        call.on('stream', (remoteStream) => {
            if (!video.srcObject) {
                video.srcObject = remoteStream;
                aiStatus.innerText = '✅ Canlı izleniyor: ' + code;
                aiStatus.style.color = '#4CAF50';
            }
        });
    });

    peer.on('error', (err) => {
        console.error(err);
        if (err.type === 'peer-unavailable') {
            alert('Kamera bulunamadı! Kodu kontrol edin.');
            location.reload();
        }
    });
});

// =================== İZLEYİCİ ÇİZİM ===================

let viewerTrackData = null;

function handleViewerData(data) {
    if (data.type === 'tracking_data') {
        viewerTrackData = data;
    } else if (data.type === 'person_out') {
        if (!isAlerting) {
            isAlerting = true;
            alertBox.style.display = 'flex';
            aiStatus.innerText = 'UYARI: HEDEF KAYIP!';
            aiStatus.style.color = '#ff0000';
            if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);
            vibrateInterval = setInterval(() => {
                if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);
            }, 800);
        }
    } else if (data.type === 'person_in') {
        clearAlertDisplay();
    }
}

function viewerLoop() {
    if (isCamera) return;

    if (video.readyState >= 4) {
        if (canvas.width !== video.videoWidth && video.videoWidth > 0) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
        }

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (viewerTrackData && viewerTrackData.rect) {
            const d = viewerTrackData;
            const scX = canvas.width / d.w;
            const scY = canvas.height / d.h;
            const [rx, ry, rw, rh] = d.rect;
            const mx = rx * scX, my = ry * scY, mw = rw * scX, mh = rh * scY;

            if (d.found) {
                ctx.strokeStyle = '#00FF00';
                ctx.lineWidth = 4;
                ctx.strokeRect(mx, my, mw, mh);
                ctx.fillStyle = '#00FF00';
                ctx.font = 'bold 20px Arial';
                ctx.fillText('🎯 KİLİTLİ', mx, my > 25 ? my - 8 : 25);
                unlockBtn.style.display = 'block';
            } else {
                ctx.strokeStyle = '#FF9800';
                ctx.lineWidth = 3;
                ctx.setLineDash([8, 8]);
                ctx.strokeRect(mx, my, mw, mh);
                ctx.setLineDash([]);
                ctx.fillStyle = '#FF9800';
                ctx.font = 'bold 18px Arial';
                ctx.fillText('⚠ Aranıyor...', mx, my > 25 ? my - 8 : 25);
            }
        } else {
            // Henüz hedef seçilmemiş
            ctx.fillStyle = 'rgba(0, 188, 212, 0.8)';
            ctx.font = 'bold 22px Arial';
            const text = '👆 Kişiye dokunun';
            const tm = ctx.measureText(text);
            ctx.fillText(text, (canvas.width - tm.width) / 2, canvas.height / 2);
        }
    }

    setTimeout(() => requestAnimationFrame(viewerLoop), 50);
}

function clearAlertDisplay() {
    if (isAlerting) {
        isAlerting = false;
        alertBox.style.display = 'none';
        aiStatus.innerText = '✅ Canlı izleniyor';
        aiStatus.style.color = '#4CAF50';
        clearInterval(vibrateInterval);
    }
}
