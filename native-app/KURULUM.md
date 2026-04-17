# 📱 KameraTakip — APK Kurulum Rehberi

## ⚡ Hızlı Başlangıç (3 Adım)

### 1. Expo Hesabı Oluştur (1 dakika)
1. https://expo.dev/signup adresine git
2. E-posta ve şifre ile ücretsiz hesap oluştur
3. Terminalde giriş yap:
```
powershell -ExecutionPolicy Bypass -Command "npx eas login"
```

### 2. APK'yı Build Et (15-20 dakika)
```
cd "c:\Users\akcel\OneDrive\Desktop\Selo çalışma alanı\kamera\native-app"
powershell -ExecutionPolicy Bypass -Command "npx eas build -p android --profile preview"
```
- İlk seferde proje ID soracak → "Yes" de
- Build bulutta çalışır (bilgisayarına Android SDK kurman gerekmez!)
- 15-20 dakika bekle

### 3. APK'yı İndir
- Build bitince terminalde link verilir
- VEYA https://expo.dev → Projects → KameraTakip → Builds → APK indir
- İndirilen APK'yı iki telefona da kur

## 🎯 Uygulama Özellikleri
- **Native TFLite**: AI modeli telefonun GPU'sunda çalışır (web'den 10x hızlı)
- **Gerçek İnsan Algılama**: Boşluk algılamaz, sadece gerçek insanları görür
- **Hedef Kilitleme**: Kişiye dokun → kilitlen → 2 saniye görünmezse alarm
- **Anında Açılır**: Web gibi model indirme beklentisi yok (ilk sefer hariç)

## ❓ Sorun Giderme
- **"eas: command not found"** → `npm install -g eas-cli` çalıştır
- **Build hatası** → `npx expo prebuild --clean` dene, sonra tekrar build et
- **APK kurulamıyor** → Telefon ayarlarında "Bilinmeyen Kaynaklar" izni ver
