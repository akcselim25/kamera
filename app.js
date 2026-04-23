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
let isBabyMode = false;
let aiWorker = null;
let modelReady = false;
let detecting = false;

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
let memoryMode = false;
let currentFilter = 'none'; // 'none', 'thermal', 'night'

// =================== YÜKLEME ===================

async function loadAI() {
    const ld = document.getElementById('ld');
    const lf = document.getElementById('lf');
    const lt = document.getElementById('lt');
    if (ld) ld.style.display = 'block';

    if (lt) lt.innerText = 'AI İş Parçacığı Başlatılıyor...';
    if (lf) lf.style.width = '30%';

    aiWorker = new Worker('worker.js?v=31');
    
    aiWorker.onmessage = (e) => {
        if (e.data.type === 'ready') {
            if (lf) lf.style.width = '100%';
            if (lt) lt.innerText = 'Hazır!';
            modelReady = true;
            as_.innerText = 'AI Hazır — Kişiye dokunun';
            as_.style.color = '#4CAF50';
            setTimeout(() => { if (ld) ld.style.display = 'none'; }, 600);
            
            // İlk çerçeveyi iste
            requestAnimationFrame(detectFrame);
        } else if (e.data.type === 'result') {
            handleDetections(e.data.detections);
            detecting = false;
            // Hemen bir sonraki kareyi işle (Ping-Pong)
            requestAnimationFrame(detectFrame);
        } else if (e.data.type === 'error') {
            console.error('AI yükleme hatası:', e.data.error);
            if (lt) lt.innerText = 'AI yüklenemedi: ' + e.data.error;
            as_.innerText = 'AI Hatası!';
            as_.style.color = '#f44336';
        }
    };
    
    if (lt) lt.innerText = 'Model İndiriliyor (Arka Plan)...';
    if (lf) lf.style.width = '60%';
    aiWorker.postMessage({ type: 'init' });
}

// =================== ALGILAMA DÖNGÜSÜ (Worker Ping-Pong) ===================

let lastSendTime = 0;

async function detectFrame() {
    if (!isCamera || isBabyMode || !aiWorker || !modelReady) return;

    if (vid.readyState >= 4 && !detecting) {
        detecting = true;
        try {
            // Çözünürlüğü düşürerek gönder ki anında işlensin (320x240 civarı optimum)
            const targetWidth = 320;
            const targetHeight = Math.floor(vid.videoHeight * (targetWidth / vid.videoWidth)) || 240;
            
            // createImageBitmap donanım desteklidir, 0 kasma yapar
            const bitmap = await createImageBitmap(vid, { 
                resizeWidth: targetWidth, 
                resizeHeight: targetHeight 
            });
            
            // Ölçek katsayısını kaydet (Worker'dan gelen sonuçları orijinal boyuta çevirmek için)
            aiWorker.scaleX = vid.videoWidth / targetWidth;
            aiWorker.scaleY = vid.videoHeight / targetHeight;
            
            aiWorker.postMessage({ type: 'detect', bitmap: bitmap }, [bitmap]);
        } catch (e) {
            console.error('Frame extraction error:', e);
            detecting = false;
            requestAnimationFrame(detectFrame);
        }
    }
}

function handleDetections(detections) {
    // MediaPipe formatından bizim [x,y,w,h] formatına çevir
    // detections array of { categories, boundingBox: {originX, originY, width, height} }
    people = [];
    if (detections && detections.length > 0) {
        for (const det of detections) {
            if (det.categories && det.categories[0] && det.categories[0].categoryName === 'person') {
                const b = det.boundingBox;
                people.push({
                    bbox: [
                        b.originX * aiWorker.scaleX, 
                        b.originY * aiWorker.scaleY, 
                        b.width * aiWorker.scaleX, 
                        b.height * aiWorker.scaleY
                    ],
                    score: det.categories[0].score
                });
            }
        }
    }

    if (lockedBbox) {
        updateLockedTarget();
    }

    // İzleyiciye gönderimi sınırla (Gereksiz ağ trafiğini engelle, 15fps yeterli)
    const now = Date.now();
    if (conn && conn.open && now - lastSendTime > 60) {
        lastSendTime = now;
        conn.send({
            type: 'tracking_data',
            w: vid.videoWidth,
            h: vid.videoHeight,
            people: people.map(p => p.bbox),
            locked: lockedBbox,
            found: lockedBbox ? isTargetFound() : false
        });
    }
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

        // Daha katı bir takip algoritması (Mesafe değişimini ağır cezalandırır)
        const score = (iou * 10) + (sizeRatio * 5) - (distRatio * 15);

        // Bir başkasına sıçramaması için kuralları katılaştırdık
        if ((iou > 0.15 || (distRatio < 0.8 && sizeRatio > 0.5)) && score > bestScore) {
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
    
    if (isBabyMode) {
        as_.innerText = '👶 BEBEK İZLENİYOR';
        as_.style.color = '#ff9a9e';
    } else {
        as_.innerText = modelReady ? 'Kişiye dokunun' : 'AI yükleniyor...';
        as_.style.color = '#00bcd4';
    }
    
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

        if (isCamera && !isBabyMode) {
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

                    // EĞER hedef tekrar döndüyse ve alarm çalıyorsa alarmı sustur
                    if (isAlerting) {
                        clearAlertDisplay();
                        if (conn && conn.open) conn.send({ type: 'person_in' });
                    }

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
                        // EĞER HAFIZA MODU AÇIKSA ASLA UNUTMA!
                        if (!memoryMode) {
                            unlockTarget();
                        }
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
    if (isBabyMode) return;
    
    const rect = cvs.getBoundingClientRect();
    
    // object-fit: cover için matematiksel olarak doğru tıklama hesaplaması
    const scale = Math.max(rect.width / cvs.width, rect.height / cvs.height);
    const renderedWidth = cvs.width * scale;
    const renderedHeight = cvs.height * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;

    const cx = (e.clientX - rect.left - offsetX) / scale;
    const cy = (e.clientY - rect.top - offsetY) / scale;

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

document.getElementById('btnCam').addEventListener('click', () => startCamera(false));
document.getElementById('btnBaby').addEventListener('click', () => startCamera(true));

async function startCamera(babyMode) {
    isCamera = true;
    isBabyMode = babyMode;
    document.getElementById('role').style.display = 'none';
    document.getElementById('main').style.display = 'block';

    if (babyMode) {
        document.getElementById('baby-controls').style.display = 'block';
    } else {
        document.getElementById('cc').style.display = 'block';
        document.getElementById('lc').style.display = 'block';
    }

    // 1. Kamerayı HEMEN aç
    let stream;
    let audioEnabled = false;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
            audio: babyMode
        });
        audioEnabled = babyMode;
    } catch (e) {
        if (babyMode) {
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
                    audio: false
                });
                alert("Mikrofon izni reddedildi! Bebek kamerasında 'Ses Algılama' devre dışı kalacak, sadece hareket algılama çalışacak.");
            } catch (fallbackErr) {
                alert('Kamera açılamadı: ' + fallbackErr.name);
                location.reload();
                return;
            }
        } else {
            alert('Kamera açılamadı: ' + e.name);
            location.reload();
            return;
        }
    }

    vid.srcObject = stream;
    vid.muted = true;
    
    if (babyMode) {
        if (audioEnabled) startAudioMonitoring(stream);
        else document.getElementById('baby-sound').innerText = 'Ses: KAPALI';
        
        startMotionMonitoring();
    }

    // Stealth (Karartma) Modu Butonu
    const stealthLogic = () => {
        document.getElementById('stealth').style.display = 'flex';
        document.getElementById('stealth-pin').value = '';
        document.getElementById('stealth-ui').style.display = 'none';
    };
    
    document.getElementById('btnHide').onclick = stealthLogic;
    const btnHideBaby = document.getElementById('btnHideBaby');
    if (btnHideBaby) btnHideBaby.onclick = stealthLogic;

    // Hedefi Sıfırlama (Uyarı ekranından)
    document.getElementById('btnResetTarget').onclick = () => {
        document.getElementById('alert').style.display = 'none';
        unlockTarget();
        if (conn && conn.open) conn.send({ type: 'viewer_unlock' });
    };
    
    document.getElementById('btnBackBaby').onclick = () => location.reload();

    // Simsiyah ekrana tıklayınca şifre sorma alanını aç
    document.getElementById('stealth').onclick = (e) => {
        if(e.target.id === 'stealth') {
            document.getElementById('stealth-ui').style.display = 'flex';
            document.getElementById('stealth-pin').focus();
        }
    };

    // Şifre kontrol tuşu
    document.getElementById('stealth-unlock').onclick = () => {
        if (document.getElementById('stealth-pin').value === '7693') {
            document.getElementById('stealth').style.display = 'none'; // Moddan çık
            document.getElementById('stealth-ui').style.display = 'none';
        } else {
            alert('Yanlış Şifre!');
            document.getElementById('stealth-pin').value = '';
            document.getElementById('stealth-ui').style.display = 'none'; // Yanlışsa tekrar kapansın tamamen
        }
    };

    // Yeni Butonlar: Termal, Gece, Hafıza
    const setFilter = (filterName) => {
        currentFilter = filterName;
        vid.className = 'filter-' + filterName;
        cvs.className = 'filter-' + filterName;
        if (conn && conn.open) {
            conn.send({ type: 'set_filter', filter: filterName });
        }
    };

    document.getElementById('btnThermal').onclick = () => {
        setFilter(currentFilter === 'thermal' ? 'none' : 'thermal');
    };

    document.getElementById('btnNight').onclick = () => {
        setFilter(currentFilter === 'night' ? 'none' : 'night');
    };

    document.getElementById('btnMemory').onclick = () => {
        memoryMode = !memoryMode;
        const btn = document.getElementById('btnMemory');
        if (memoryMode) {
            btn.innerText = '🧠 Hafıza Açık';
            btn.style.background = 'rgba(100,100,255,0.6)';
        } else {
            btn.innerText = '🧠 Hafıza Kapalı';
            btn.style.background = 'rgba(100,100,255,0.2)';
        }
    };

    // UI Gizle/Göster Butonu
    document.getElementById('btnToggleUI').style.display = 'block';
    let uiHidden = false;
    document.getElementById('btnToggleUI').onclick = () => {
        uiHidden = !uiHidden;
        const wrapper = document.getElementById('controls-wrapper');
        const btn = document.getElementById('btnToggleUI');
        if(uiHidden) {
            wrapper.style.transform = 'translateY(calc(100% + 40px))';
            btn.innerText = '▲ GÖSTER';
        } else {
            wrapper.style.transform = 'translateY(0)';
            btn.innerText = '▼ GİZLE';
        }
    };

    // 2. PeerJS'i HEMEN başlat (Arka planda hazırlandıysa onu kullan)
    if (babyMode) {
        document.getElementById('mc-baby').innerText = precode;
    } else {
        document.getElementById('mc').innerText = precode;
    }
    peer = prepeer;

    const setupHost = () => {
        cs.innerText = 'Hazır — İzleyici bekleniyor';
        cp.className = 'p g';
        drawLoop();
        if (!babyMode) loadAI();
    };

    if (peer.open) {
        setupHost();
    } else {
        cs.innerText = 'Bağlanıyor (Hızlandırıldı)...';
        peer.on('open', setupHost);
    }

    peer.on('connection', (c) => {
        conn = c;
        cs.innerText = 'İzleyici bağlandı!';
        if (babyMode) conn.send({ type: 'mode_baby' });
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
}

// =================== İZLEYİCİ MODU ===================

document.getElementById('btnView').addEventListener('click', () => {
    // İzleyici moduna geçilirse, kamera için hazırlanan peer'ı yokedip baştan bağlan
    if(prepeer && !prepeer.destroyed) prepeer.destroy();
    document.getElementById('role').style.display = 'none';
    document.getElementById('vs').style.display = 'flex';
});

document.getElementById('btnConn').addEventListener('click', () => {
    const code = document.getElementById('jc').value.trim();
    if (code.length !== 5) { alert('5 haneli kodu girin!'); return; }

    document.getElementById('vs').style.display = 'none';
    document.getElementById('main').style.display = 'block';
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
            document.getElementById('btnToggleUI').style.display = 'block';
            
            // İzleyici için de UI Gizle/Göster
            let uiHidden = false;
            document.getElementById('btnToggleUI').onclick = () => {
                uiHidden = !uiHidden;
                const wrapper = document.getElementById('controls-wrapper');
                const btn = document.getElementById('btnToggleUI');
                if(uiHidden) {
                    wrapper.style.transform = 'translateY(calc(100% + 40px))';
                    btn.innerText = '▲ GÖSTER';
                } else {
                    wrapper.style.transform = 'translateY(0)';
                    btn.innerText = '▼ GİZLE';
                }
            };
            
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
    else if (d.type === 'mode_baby') {
        isBabyMode = true;
        document.getElementById('lc').style.display = 'block';
        document.getElementById('as').innerText = '👶 BEBEK İZLENİYOR';
        document.getElementById('as').style.color = '#ff9a9e';
        document.getElementById('btnToggleUI').style.display = 'block';
    }
    else if (d.type === 'baby_alert') {
        const al = document.getElementById('alert');
        const icon = document.getElementById('alert-icon');
        const title = document.getElementById('alert-title');
        const msg = document.getElementById('alert-msg');
        const btn = document.getElementById('btnResetTarget');
        
        if (d.alert === 'sound_start' || d.alert === 'motion_start') {
            icon.innerText = d.alert === 'sound_start' ? '👶🔊' : '👶🚼';
            title.innerText = 'BEBEK UYARISI';
            msg.innerText = d.alert === 'sound_start' ? 'BEBEK SES ÇIKARIYOR / AĞLIYOR!' : 'BEBEK HAREKET ETTİ!';
            btn.innerText = 'TAMAM (SUSTUR)';
            al.style.display = 'flex';
            if (navigator.vibrate) navigator.vibrate([500, 200, 500]);
        }
    }
    else if (d.type === 'set_filter') {
        vid.className = 'filter-' + d.filter;
        cvs.className = 'filter-' + d.filter;
    }
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

// =================== ARKA PLAN OPTİMİZASYONLARI ===================
// Kullanıcı "Kamera Ol" demeden önce bekleme süresini SIFIRA indirmek için:
// Sayfa açılır açılmaz PeerJS id'si alınmaya başlar (Background Pre-fetch)
let precode = Math.floor(10000 + Math.random() * 90000).toString();
let prepeer = new Peer('phtrck-' + precode, { debug: 0 });

// Global exports for onclick handlers
window.unlockTarget = unlockTarget;

// =================== BEBEK İZLEME ===================

let babyAudioAlert = false;
let babyMotionAlert = false;

function startAudioMonitoring(stream) {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let highVolumeFrames = 0;
    
    function monitor() {
        if (!isBabyMode) return;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0; 
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        let avg = sum / dataArray.length;
        
        if (avg > 40) highVolumeFrames++;
        else {
            highVolumeFrames = 0;
            if (babyAudioAlert) {
                babyAudioAlert = false;
                document.getElementById('baby-sound').innerText = 'Ses: 🟢';
                document.getElementById('baby-sound').style.background = 'rgba(0,0,0,0.5)';
            }
        }
        
        if (highVolumeFrames > 30 && !babyAudioAlert) { 
            babyAudioAlert = true;
            document.getElementById('baby-sound').innerText = 'Ses: 🔴 AĞLIYOR!';
            document.getElementById('baby-sound').style.background = 'rgba(255,0,0,0.5)';
            if (conn && conn.open) conn.send({ type: 'baby_alert', alert: 'sound_start' });
        }
        requestAnimationFrame(monitor);
    }
    monitor();
}

function startMotionMonitoring() {
    const motionCanvas = document.createElement('canvas');
    const motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });
    let prevFrame = null;
    
    setInterval(() => {
        if (!isBabyMode || !vid.videoWidth) return;
        motionCanvas.width = 64; motionCanvas.height = 48;
        motionCtx.drawImage(vid, 0, 0, 64, 48);
        const currentFrame = motionCtx.getImageData(0, 0, 64, 48).data;
        
        if (prevFrame) {
            let diff = 0;
            for (let i = 0; i < currentFrame.length; i += 4) {
                diff += Math.abs(currentFrame[i] - prevFrame[i]);
                diff += Math.abs(currentFrame[i+1] - prevFrame[i+1]);
                diff += Math.abs(currentFrame[i+2] - prevFrame[i+2]);
            }
            if (diff / (64 * 48 * 3) > 12 && !babyMotionAlert) { 
                babyMotionAlert = true;
                document.getElementById('baby-motion').innerText = 'Hareket: 🔴 HAREKET!';
                document.getElementById('baby-motion').style.background = 'rgba(255,0,0,0.5)';
                if (conn && conn.open) conn.send({ type: 'baby_alert', alert: 'motion_start' });
                
                setTimeout(() => {
                    babyMotionAlert = false;
                    document.getElementById('baby-motion').innerText = 'Hareket: 🟢';
                    document.getElementById('baby-motion').style.background = 'rgba(0,0,0,0.5)';
                }, 4000);
            }
        }
        prevFrame = currentFrame;
    }, 500); 
}
